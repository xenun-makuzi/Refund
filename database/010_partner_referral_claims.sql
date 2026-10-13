-- REFUND PLATFORM - PARTNER REFERRAL CLAIM INTAKE
-- Migration 010. Requires migrations 001 and 002 (and existing platform modules).
-- Admins can create a claim before a customer has an account. The claim is linked
-- only after a signed-in customer has a confirmed email and a verified partner referral.

BEGIN;

-- Pre-created claims must be allowed to remain unassigned until the customer registers.
ALTER TABLE public.claims ALTER COLUMN user_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.partner_claim_intakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL UNIQUE REFERENCES public.claims(id) ON DELETE CASCADE,
  partner_organization_id UUID NOT NULL REFERENCES public.partner_organizations(id) ON DELETE RESTRICT,
  invited_email TEXT NOT NULL CHECK (char_length(trim(invited_email)) BETWEEN 3 AND 254),
  invited_name TEXT NOT NULL CHECK (char_length(trim(invited_name)) BETWEEN 2 AND 160),
  status TEXT NOT NULL DEFAULT 'pending_registration'
    CHECK (status IN ('pending_registration', 'linked', 'cancelled')),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  linked_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_claim_intakes_email_partner_idx
  ON public.partner_claim_intakes (lower(invited_email), partner_organization_id, status);
CREATE INDEX IF NOT EXISTS partner_claim_intakes_status_created_idx
  ON public.partner_claim_intakes (status, created_at DESC);

ALTER TABLE public.partner_claim_intakes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Partner claim intakes: admins read" ON public.partner_claim_intakes;
CREATE POLICY "Partner claim intakes: admins read"
  ON public.partner_claim_intakes FOR SELECT TO authenticated
  USING (public.is_admin());
REVOKE ALL ON TABLE public.partner_claim_intakes FROM anon, authenticated;
GRANT SELECT ON TABLE public.partner_claim_intakes TO authenticated;

-- Preserve the partner/company values for unassigned claims. Existing customer-created
-- claims continue to derive their origin from trusted profile/referral records.
CREATE OR REPLACE FUNCTION public.set_claim_origin_from_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_source public.onboarding_source;
  v_partner_id UUID;
BEGIN
  IF NEW.user_id IS NULL THEN
    IF NEW.origin <> 'partner_referral'::public.claim_origin
       OR NEW.partner_organization_id IS NULL THEN
      RAISE EXCEPTION 'Unassigned claims must be created for a partner referral';
    END IF;
  ELSE
    SELECT p.onboarding_source INTO v_source
    FROM public.profiles AS p WHERE p.id = NEW.user_id;

    IF v_source = 'partner_referral'::public.onboarding_source THEN
      NEW.origin := 'partner_referral'::public.claim_origin;
      SELECT prs.matched_partner_id INTO v_partner_id
      FROM public.partner_referral_submissions AS prs
      WHERE prs.user_id = NEW.user_id
        AND prs.status = 'verified'::public.partner_referral_status
      LIMIT 1;
      NEW.partner_organization_id := v_partner_id;
    ELSE
      NEW.origin := 'direct'::public.claim_origin;
      NEW.partner_organization_id := NULL;
    END IF;
  END IF;

  -- Never accept client-supplied assignment/resolution fields on claim creation.
  NEW.assigned_to := NULL;
  NEW.assigned_by := NULL;
  NEW.assigned_at := NULL;
  NEW.resolution_summary := NULL;
  NEW.resolved_by := NULL;
  NEW.resolved_at := NULL;
  NEW.closed_at := NULL;
  NEW.status := 'submitted'::public.claim_status;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_claim_origin_from_profile() FROM PUBLIC, anon, authenticated;

-- Admin-only RPC for creating partner organizations. The code is a referral identifier,
-- not an authentication credential or proof that a customer owns a claim.
CREATE OR REPLACE FUNCTION public.admin_create_partner_organization(
  p_name TEXT,
  p_referral_code TEXT
)
RETURNS public.partner_organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_row public.partner_organizations;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator access required'; END IF;
  IF length(trim(coalesce(p_name, ''))) < 2 OR length(trim(p_name)) > 200 THEN
    RAISE EXCEPTION 'Enter a valid partner name';
  END IF;
  IF length(trim(coalesce(p_referral_code, ''))) < 4 OR length(trim(p_referral_code)) > 100 THEN
    RAISE EXCEPTION 'Referral code must be between 4 and 100 characters';
  END IF;
  INSERT INTO public.partner_organizations (name, referral_code, is_active)
  VALUES (trim(p_name), trim(p_referral_code), TRUE)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_create_partner_organization(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_partner_organization(TEXT, TEXT) TO authenticated;

-- Admin-only RPC: create a claim without a user account, then record the expected email.
CREATE OR REPLACE FUNCTION public.admin_create_partner_claim(
  p_partner_id UUID,
  p_customer_email TEXT,
  p_customer_name TEXT,
  p_category public.claim_category,
  p_title TEXT,
  p_description TEXT,
  p_merchant_name TEXT DEFAULT NULL,
  p_transaction_date DATE DEFAULT NULL,
  p_requested_amount NUMERIC DEFAULT NULL,
  p_currency TEXT DEFAULT 'USD'
)
RETURNS TABLE (claim_id UUID, case_reference TEXT, intake_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_claim public.claims;
  v_intake UUID;
  v_email TEXT := lower(trim(coalesce(p_customer_email, '')));
  v_name TEXT := trim(coalesce(p_customer_name, ''));
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator access required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.partner_organizations po WHERE po.id = p_partner_id AND po.is_active) THEN
    RAISE EXCEPTION 'Select an active partner organization';
  END IF;
  IF v_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' THEN RAISE EXCEPTION 'Enter a valid customer email'; END IF;
  IF length(v_name) < 2 OR length(v_name) > 160 THEN RAISE EXCEPTION 'Enter the customer legal name'; END IF;
  IF length(trim(coalesce(p_title, ''))) < 5 OR length(trim(coalesce(p_title, ''))) > 180 THEN RAISE EXCEPTION 'Claim title must be 5–180 characters'; END IF;
  IF length(trim(coalesce(p_description, ''))) < 20 OR length(trim(coalesce(p_description, ''))) > 10000 THEN RAISE EXCEPTION 'Claim description must be 20–10000 characters'; END IF;
  IF p_requested_amount IS NOT NULL AND p_requested_amount < 0 THEN RAISE EXCEPTION 'Amount cannot be negative'; END IF;
  IF upper(coalesce(p_currency, '')) !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Enter a valid three-letter currency code'; END IF;

  INSERT INTO public.claims (
    user_id, category, title, description, merchant_name, transaction_date,
    requested_amount, currency, origin, partner_organization_id
  ) VALUES (
    NULL, p_category, trim(p_title), trim(p_description), nullif(trim(coalesce(p_merchant_name, '')), ''),
    p_transaction_date, p_requested_amount, upper(p_currency),
    'partner_referral'::public.claim_origin, p_partner_id
  ) RETURNING * INTO v_claim;

  INSERT INTO public.partner_claim_intakes (
    claim_id, partner_organization_id, invited_email, invited_name, created_by
  ) VALUES (
    v_claim.id, p_partner_id, v_email, v_name, auth.uid()
  ) RETURNING id INTO v_intake;

  INSERT INTO public.claim_activity (claim_id, actor_id, activity_type, visibility, body)
  VALUES (v_claim.id, auth.uid(), 'system'::public.claim_activity_type, 'internal'::public.claim_activity_visibility,
          'Partner-referred claim created and awaiting verified customer registration.');

  RETURN QUERY SELECT v_claim.id, v_claim.case_reference, v_intake;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_create_partner_claim(UUID, TEXT, TEXT, public.claim_category, TEXT, TEXT, TEXT, DATE, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_partner_claim(UUID, TEXT, TEXT, public.claim_category, TEXT, TEXT, TEXT, DATE, NUMERIC, TEXT) TO authenticated;

-- Called after the customer has signed in. It requires a confirmed Auth email, a verified
-- partner referral already matched by the signup trigger, and an exact email+partner match.
-- A company name or referral code alone never grants access to a pre-created claim.
CREATE OR REPLACE FUNCTION public.claim_partner_referrals_for_current_user()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_email TEXT;
  v_partner UUID;
  v_count INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in is required'; END IF;
  SELECT lower(u.email) INTO v_email
  FROM auth.users u
  WHERE u.id = v_uid AND u.email_confirmed_at IS NOT NULL;
  IF v_email IS NULL THEN RETURN 0; END IF;

  SELECT prs.matched_partner_id INTO v_partner
  FROM public.partner_referral_submissions prs
  WHERE prs.user_id = v_uid
    AND prs.status = 'verified'::public.partner_referral_status
    AND prs.matched_partner_id IS NOT NULL
  LIMIT 1;
  IF v_partner IS NULL THEN RETURN 0; END IF;

  WITH matched AS (
    UPDATE public.claims c
       SET user_id = v_uid,
           origin = 'partner_referral'::public.claim_origin,
           partner_organization_id = v_partner,
           updated_at = now()
      FROM public.partner_claim_intakes i
     WHERE i.claim_id = c.id
       AND i.partner_organization_id = v_partner
       AND lower(i.invited_email) = v_email
       AND i.status = 'pending_registration'
       AND c.user_id IS NULL
    RETURNING c.id, c.case_reference
  ), marked AS (
    UPDATE public.partner_claim_intakes i
       SET status = 'linked', linked_user_id = v_uid, linked_at = now(), updated_at = now()
      FROM matched m
     WHERE i.claim_id = m.id
    RETURNING i.claim_id
  ), activity AS (
    INSERT INTO public.claim_activity (claim_id, actor_id, activity_type, visibility, body)
    SELECT m.id, v_uid, 'system'::public.claim_activity_type,
           'customer'::public.claim_activity_visibility,
           'A claim from your referring organization has been linked to your account. Reference: ' || m.case_reference
    FROM matched m
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM marked;
  RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_partner_referrals_for_current_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_partner_referrals_for_current_user() TO authenticated;

COMMIT;
