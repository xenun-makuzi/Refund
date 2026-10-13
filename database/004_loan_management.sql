-- ============================================================
-- REFUND PLATFORM - LOAN APPLICATIONS & LOAN WITHDRAWALS
-- Migration 004. Requires migrations 001, 002, and 003.
-- Run the complete file in a NEW Supabase SQL Editor query.
--
-- This migration records applications and manual payout decisions.
-- It does NOT move money or connect to a lender/payment provider.
-- ============================================================

BEGIN;

-- 1. ENUMS
DO $$ BEGIN
  CREATE TYPE public.loan_application_status AS ENUM (
    'submitted',
    'under_review',
    'additional_information_required',
    'approved',
    'rejected',
    'withdrawn'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TYPE public.loan_withdrawal_status AS ENUM (
    'requested',
    'approved',
    'denied',
    'processing',
    'paid',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$ LANGUAGE plpgsql;

-- Reuses public.payout_method from migration 003:
-- bank_transfer, crypto, other.

-- 2. LOAN APPLICATIONS
CREATE TABLE IF NOT EXISTS public.loan_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_reference TEXT NOT NULL UNIQUE DEFAULT (
    'LN-' || to_char(now(), 'YYYY') || '-' ||
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  ),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  requested_amount NUMERIC(14,2) NOT NULL CHECK (requested_amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  purpose TEXT NOT NULL CHECK (char_length(trim(purpose)) BETWEEN 10 AND 3000),
  requested_term_months INTEGER CHECK (
    requested_term_months IS NULL OR requested_term_months BETWEEN 1 AND 120
  ),
  status public.loan_application_status NOT NULL DEFAULT 'submitted',
  approved_amount NUMERIC(14,2) CHECK (
    approved_amount IS NULL OR approved_amount > 0
  ),
  approved_term_months INTEGER CHECK (
    approved_term_months IS NULL OR approved_term_months BETWEEN 1 AND 120
  ),
  decision_reason TEXT CHECK (
    decision_reason IS NULL OR char_length(decision_reason) <= 2000
  ),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loan_approved_amount_matches_status CHECK (
    (status = 'approved'::public.loan_application_status AND approved_amount IS NOT NULL)
    OR
    (status <> 'approved'::public.loan_application_status AND approved_amount IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS loan_applications_user_created_idx
  ON public.loan_applications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS loan_applications_status_created_idx
  ON public.loan_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS loan_applications_reference_idx
  ON public.loan_applications(application_reference);

-- 3. APPLICATION EVENT HISTORY
CREATE TABLE IF NOT EXISTS public.loan_application_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_application_id UUID NOT NULL
    REFERENCES public.loan_applications(id) ON DELETE RESTRICT,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'application_submitted',
    'status_changed',
    'decision_made',
    'customer_update'
  )),
  previous_status public.loan_application_status,
  new_status public.loan_application_status NOT NULL,
  event_note TEXT NOT NULL CHECK (
    char_length(trim(event_note)) BETWEEN 1 AND 2000
  ),
  customer_visible BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_application_events_app_created_idx
  ON public.loan_application_events(loan_application_id, created_at ASC);

-- 4. LOAN WITHDRAWAL REQUESTS
-- A request is for the full approved amount in this first version.
-- A denied or failed request can be re-submitted; a paid request cannot.
CREATE TABLE IF NOT EXISTS public.loan_withdrawal_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_reference TEXT NOT NULL UNIQUE DEFAULT (
    'LW-' || to_char(now(), 'YYYY') || '-' ||
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  ),
  loan_application_id UUID NOT NULL
    REFERENCES public.loan_applications(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  method public.payout_method NOT NULL,
  destination_details JSONB NOT NULL CHECK (
    jsonb_typeof(destination_details) = 'object'
    AND destination_details <> '{}'::jsonb
  ),
  status public.loan_withdrawal_status NOT NULL DEFAULT 'requested',
  decision_reason TEXT CHECK (
    decision_reason IS NULL OR char_length(decision_reason) <= 2000
  ),
  provider_reference TEXT CHECK (
    provider_reference IS NULL OR char_length(provider_reference) <= 200
  ),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loan_withdrawals_user_created_idx
  ON public.loan_withdrawal_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS loan_withdrawals_status_created_idx
  ON public.loan_withdrawal_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS loan_withdrawals_application_idx
  ON public.loan_withdrawal_requests(loan_application_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS loan_withdrawals_one_active_or_paid_per_application_uidx
  ON public.loan_withdrawal_requests(loan_application_id)
  WHERE status IN (
    'requested'::public.loan_withdrawal_status,
    'approved'::public.loan_withdrawal_status,
    'processing'::public.loan_withdrawal_status,
    'paid'::public.loan_withdrawal_status
  );

-- 5. WITHDRAWAL EVENT HISTORY (no destination details are copied here)
CREATE TABLE IF NOT EXISTS public.loan_withdrawal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_request_id UUID NOT NULL
    REFERENCES public.loan_withdrawal_requests(id) ON DELETE RESTRICT,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  previous_status public.loan_withdrawal_status,
  new_status public.loan_withdrawal_status NOT NULL,
  event_note TEXT NOT NULL CHECK (
    char_length(trim(event_note)) BETWEEN 1 AND 2000
  ),
  customer_visible BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_withdrawal_events_request_created_idx
  ON public.loan_withdrawal_events(withdrawal_request_id, created_at ASC);

-- 6. CUSTOMER RPC: SUBMIT AN APPLICATION
CREATE OR REPLACE FUNCTION public.submit_loan_application(
  p_requested_amount NUMERIC,
  p_currency TEXT,
  p_purpose TEXT,
  p_requested_term_months INTEGER DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_profile public.profiles%ROWTYPE;
  v_application_id UUID;
  v_currency TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must sign in before applying for a loan.' USING ERRCODE = '42501';
  END IF;

  IF p_requested_amount IS NULL OR p_requested_amount <= 0
     OR p_requested_amount > 999999999999.99 THEN
    RAISE EXCEPTION 'Enter a valid positive loan amount.' USING ERRCODE = '22023';
  END IF;

  v_currency := upper(trim(COALESCE(p_currency, '')));
  IF char_length(v_currency) <> 3 OR v_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Choose a valid three-letter currency.' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(char_length(trim(p_purpose)), 0) < 10
     OR char_length(p_purpose) > 3000 THEN
    RAISE EXCEPTION 'Please explain the purpose of the loan in 10 to 3000 characters.' USING ERRCODE = '22023';
  END IF;

  IF p_requested_term_months IS NOT NULL
     AND p_requested_term_months NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Requested term must be between 1 and 120 months.' USING ERRCODE = '22023';
  END IF;

  SELECT p.* INTO v_profile
  FROM public.profiles AS p
  WHERE p.id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Your account profile is not ready. Please contact support.' USING ERRCODE = 'P0002';
  END IF;
  IF v_profile.account_status <> 'active'::public.account_status THEN
    RAISE EXCEPTION 'Loan applications are unavailable while your account is restricted.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.loan_applications (
    user_id, requested_amount, currency, purpose, requested_term_months, status
  ) VALUES (
    v_user_id, round(p_requested_amount, 2), v_currency,
    trim(p_purpose), p_requested_term_months,
    'submitted'::public.loan_application_status
  ) RETURNING id INTO v_application_id;

  INSERT INTO public.loan_application_events (
    loan_application_id, actor_id, event_type, previous_status,
    new_status, event_note, customer_visible
  ) VALUES (
    v_application_id, v_user_id, 'application_submitted', NULL,
    'submitted'::public.loan_application_status,
    'Your loan application was submitted and is awaiting review.', TRUE
  );

  RETURN v_application_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_loan_application(NUMERIC, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_loan_application(NUMERIC, TEXT, TEXT, INTEGER) TO authenticated;

-- 7. ADMIN RPC: REVIEW APPLICATIONS
CREATE OR REPLACE FUNCTION public.admin_review_loan_application(
  p_loan_application_id UUID,
  p_new_status public.loan_application_status,
  p_approved_amount NUMERIC DEFAULT NULL,
  p_approved_term_months INTEGER DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_app public.loan_applications%ROWTYPE;
  v_approved_amount NUMERIC(14,2);
  v_approved_term INTEGER;
  v_event_type TEXT;
  v_note TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can review loan applications.' USING ERRCODE = '42501';
  END IF;

  IF p_new_status IS NULL OR p_new_status NOT IN (
    'under_review'::public.loan_application_status,
    'additional_information_required'::public.loan_application_status,
    'approved'::public.loan_application_status,
    'rejected'::public.loan_application_status
  ) THEN
    RAISE EXCEPTION 'That is not a permitted admin review status.' USING ERRCODE = '22023';
  END IF;

  SELECT la.* INTO v_app
  FROM public.loan_applications AS la
  WHERE la.id = p_loan_application_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan application not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_app.status IN (
    'approved'::public.loan_application_status,
    'rejected'::public.loan_application_status,
    'withdrawn'::public.loan_application_status
  ) THEN
    RAISE EXCEPTION 'This application already has a final decision.' USING ERRCODE = '22023';
  END IF;

  IF p_new_status IN (
      'rejected'::public.loan_application_status,
      'additional_information_required'::public.loan_application_status
    ) AND COALESCE(char_length(trim(p_reason)), 0) < 3 THEN
    RAISE EXCEPTION 'Provide a reason or explain what information is required.' USING ERRCODE = '22023';
  END IF;

  v_approved_amount := NULL;
  v_approved_term := NULL;
  IF p_new_status = 'approved'::public.loan_application_status THEN
    v_approved_amount := COALESCE(p_approved_amount, v_app.requested_amount);
    IF v_approved_amount <= 0 OR v_approved_amount > v_app.requested_amount THEN
      RAISE EXCEPTION 'Approved amount must be positive and cannot exceed the requested amount.' USING ERRCODE = '22023';
    END IF;
    IF p_approved_term_months IS NOT NULL
       AND p_approved_term_months NOT BETWEEN 1 AND 120 THEN
      RAISE EXCEPTION 'Approved term must be between 1 and 120 months.' USING ERRCODE = '22023';
    END IF;
    v_approved_term := COALESCE(p_approved_term_months, v_app.requested_term_months);
  END IF;

  v_event_type := CASE
    WHEN p_new_status IN (
      'approved'::public.loan_application_status,
      'rejected'::public.loan_application_status
    ) THEN 'decision_made'
    ELSE 'status_changed'
  END;

  v_note := NULLIF(left(trim(COALESCE(p_reason, '')), 2000), '');
  IF v_note IS NULL THEN
    v_note := CASE p_new_status
      WHEN 'under_review'::public.loan_application_status
        THEN 'Your loan application is now under review.'
      WHEN 'approved'::public.loan_application_status
        THEN 'Your loan application has been approved. You can request withdrawal from your dashboard, subject to identity and administrative checks.'
      ELSE 'Your loan application status has been updated.'
    END;
  END IF;

  UPDATE public.loan_applications
  SET status = p_new_status,
      approved_amount = v_approved_amount,
      approved_term_months = v_approved_term,
      decision_reason = v_note,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  WHERE id = v_app.id;

  INSERT INTO public.loan_application_events (
    loan_application_id, actor_id, event_type, previous_status,
    new_status, event_note, customer_visible
  ) VALUES (
    v_app.id, auth.uid(), v_event_type, v_app.status,
    p_new_status, v_note, TRUE
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_review_loan_application(UUID, public.loan_application_status, NUMERIC, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_loan_application(UUID, public.loan_application_status, NUMERIC, INTEGER, TEXT) TO authenticated;

-- 8. CUSTOMER RPC: REQUEST WITHDRAWAL OF THE FULL APPROVED LOAN AMOUNT
CREATE OR REPLACE FUNCTION public.request_loan_withdrawal(
  p_loan_application_id UUID,
  p_method public.payout_method,
  p_destination_details JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_app public.loan_applications%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_request_id UUID;
  v_existing BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must sign in before requesting a loan withdrawal.' USING ERRCODE = '42501';
  END IF;

  IF p_destination_details IS NULL
     OR jsonb_typeof(p_destination_details) IS DISTINCT FROM 'object'
     OR p_destination_details = '{}'::jsonb THEN
    RAISE EXCEPTION 'Enter the destination details for the selected payout method.' USING ERRCODE = '22023';
  END IF;

  SELECT la.* INTO v_app
  FROM public.loan_applications AS la
  WHERE la.id = p_loan_application_id
    AND la.user_id = v_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved loan not found for this account.' USING ERRCODE = 'P0002';
  END IF;

  IF v_app.status <> 'approved'::public.loan_application_status
     OR v_app.approved_amount IS NULL THEN
    RAISE EXCEPTION 'Only an approved loan can be withdrawn.' USING ERRCODE = '22023';
  END IF;

  SELECT p.* INTO v_profile
  FROM public.profiles AS p
  WHERE p.id = v_user_id;
  IF NOT FOUND
     OR v_profile.account_status <> 'active'::public.account_status
     OR v_profile.identity_status <> 'verified'::public.identity_verification_status THEN
    RAISE EXCEPTION 'Your account must be active and your identity verified before requesting withdrawal.' USING ERRCODE = '42501';
  END IF;

  IF p_method = 'bank_transfer'::public.payout_method THEN
    IF char_length(trim(COALESCE(p_destination_details ->> 'bank_name', ''))) NOT BETWEEN 2 AND 120
       OR char_length(trim(COALESCE(p_destination_details ->> 'account_name', ''))) NOT BETWEEN 2 AND 160
       OR char_length(trim(COALESCE(p_destination_details ->> 'account_number', ''))) NOT BETWEEN 4 AND 100 THEN
      RAISE EXCEPTION 'For bank transfer, provide a bank name, account-holder name, and valid account number.' USING ERRCODE = '22023';
    END IF;
  ELSIF p_method = 'crypto'::public.payout_method THEN
    IF char_length(trim(COALESCE(p_destination_details ->> 'asset', ''))) NOT BETWEEN 2 AND 20
       OR char_length(trim(COALESCE(p_destination_details ->> 'network', ''))) NOT BETWEEN 2 AND 80
       OR char_length(trim(COALESCE(p_destination_details ->> 'wallet_address', ''))) NOT BETWEEN 10 AND 200 THEN
      RAISE EXCEPTION 'For crypto, provide the asset, network, and destination wallet address.' USING ERRCODE = '22023';
    END IF;
  ELSIF p_method = 'other'::public.payout_method THEN
    IF char_length(trim(COALESCE(p_destination_details ->> 'details', ''))) NOT BETWEEN 5 AND 500 THEN
      RAISE EXCEPTION 'Describe the other requested payout method.' USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported withdrawal method.' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.loan_withdrawal_requests AS wr
    WHERE wr.loan_application_id = v_app.id
      AND wr.status IN (
        'requested'::public.loan_withdrawal_status,
        'approved'::public.loan_withdrawal_status,
        'processing'::public.loan_withdrawal_status,
        'paid'::public.loan_withdrawal_status
      )
  ) INTO v_existing;

  IF v_existing THEN
    RAISE EXCEPTION 'A withdrawal request is already active or has been paid for this loan.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.loan_withdrawal_requests (
    loan_application_id, user_id, amount, currency, method,
    destination_details, status
  ) VALUES (
    v_app.id, v_user_id, v_app.approved_amount, v_app.currency,
    p_method, p_destination_details, 'requested'::public.loan_withdrawal_status
  ) RETURNING id INTO v_request_id;

  INSERT INTO public.loan_withdrawal_events (
    withdrawal_request_id, actor_id, previous_status,
    new_status, event_note, customer_visible
  ) VALUES (
    v_request_id, v_user_id, NULL,
    'requested'::public.loan_withdrawal_status,
    'Your loan withdrawal request has been submitted and is awaiting administrator review.', TRUE
  );

  RETURN v_request_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.request_loan_withdrawal(UUID, public.payout_method, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_loan_withdrawal(UUID, public.payout_method, JSONB) TO authenticated;

-- 9. ADMIN RPC: UPDATE WITHDRAWAL DECISION / MANUAL DISBURSEMENT STATE
CREATE OR REPLACE FUNCTION public.admin_update_loan_withdrawal_status(
  p_withdrawal_request_id UUID,
  p_new_status public.loan_withdrawal_status,
  p_reason TEXT DEFAULT NULL,
  p_provider_reference TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_request public.loan_withdrawal_requests%ROWTYPE;
  v_note TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can update a loan withdrawal request.' USING ERRCODE = '42501';
  END IF;

  SELECT wr.* INTO v_request
  FROM public.loan_withdrawal_requests AS wr
  WHERE wr.id = p_withdrawal_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan withdrawal request not found.' USING ERRCODE = 'P0002';
  END IF;

  IF p_new_status IS NULL OR NOT (
    (v_request.status = 'requested'::public.loan_withdrawal_status
      AND p_new_status IN ('approved'::public.loan_withdrawal_status, 'denied'::public.loan_withdrawal_status))
    OR
    (v_request.status = 'approved'::public.loan_withdrawal_status
      AND p_new_status IN ('processing'::public.loan_withdrawal_status, 'denied'::public.loan_withdrawal_status))
    OR
    (v_request.status = 'processing'::public.loan_withdrawal_status
      AND p_new_status IN ('paid'::public.loan_withdrawal_status, 'failed'::public.loan_withdrawal_status))
  ) THEN
    RAISE EXCEPTION 'That withdrawal status transition is not allowed.' USING ERRCODE = '22023';
  END IF;

  IF p_new_status IN (
    'denied'::public.loan_withdrawal_status,
    'failed'::public.loan_withdrawal_status
  ) AND COALESCE(char_length(trim(p_reason)), 0) < 3 THEN
    RAISE EXCEPTION 'Provide a reason when denying or failing a withdrawal.' USING ERRCODE = '22023';
  END IF;

  IF p_new_status = 'paid'::public.loan_withdrawal_status
     AND COALESCE(char_length(trim(p_provider_reference)), 0) < 3 THEN
    RAISE EXCEPTION 'A confirmed transaction reference is required before marking a withdrawal paid.' USING ERRCODE = '22023';
  END IF;

  v_note := NULLIF(left(trim(COALESCE(p_reason, '')), 2000), '');
  IF v_note IS NULL THEN
    v_note := CASE p_new_status
      WHEN 'approved'::public.loan_withdrawal_status THEN 'Your loan withdrawal request has been approved.'
      WHEN 'processing'::public.loan_withdrawal_status THEN 'Your loan withdrawal is being processed.'
      WHEN 'paid'::public.loan_withdrawal_status THEN 'Your loan withdrawal has been marked paid after confirmation.'
      ELSE 'The withdrawal status has been updated.'
    END;
  END IF;

  UPDATE public.loan_withdrawal_requests
  SET status = p_new_status,
      decision_reason = v_note,
      provider_reference = CASE
        WHEN p_new_status = 'paid'::public.loan_withdrawal_status
          THEN left(trim(p_provider_reference), 200)
        ELSE provider_reference
      END,
      reviewed_by = CASE
        WHEN p_new_status IN ('approved'::public.loan_withdrawal_status, 'denied'::public.loan_withdrawal_status)
          THEN auth.uid()
        ELSE reviewed_by
      END,
      reviewed_at = CASE
        WHEN p_new_status IN ('approved'::public.loan_withdrawal_status, 'denied'::public.loan_withdrawal_status)
          THEN now()
        ELSE reviewed_at
      END,
      paid_at = CASE
        WHEN p_new_status = 'paid'::public.loan_withdrawal_status THEN now()
        ELSE paid_at
      END,
      updated_at = now()
  WHERE id = v_request.id;

  INSERT INTO public.loan_withdrawal_events (
    withdrawal_request_id, actor_id, previous_status,
    new_status, event_note, customer_visible
  ) VALUES (
    v_request.id, auth.uid(), v_request.status,
    p_new_status, v_note, TRUE
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_update_loan_withdrawal_status(UUID, public.loan_withdrawal_status, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_loan_withdrawal_status(UUID, public.loan_withdrawal_status, TEXT, TEXT) TO authenticated;

-- 10. ROW LEVEL SECURITY
ALTER TABLE public.loan_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_application_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_withdrawal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_withdrawal_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Loan applications: owner or admin read" ON public.loan_applications;
DROP POLICY IF EXISTS "Loan application events: visible to owner or admin" ON public.loan_application_events;
DROP POLICY IF EXISTS "Loan withdrawals: owner or admin read" ON public.loan_withdrawal_requests;
DROP POLICY IF EXISTS "Loan withdrawal events: visible to owner or admin" ON public.loan_withdrawal_events;

CREATE POLICY "Loan applications: owner or admin read"
ON public.loan_applications
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()) OR public.is_admin());

CREATE POLICY "Loan application events: visible to owner or admin"
ON public.loan_application_events
FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    customer_visible = TRUE
    AND EXISTS (
      SELECT 1 FROM public.loan_applications AS la
      WHERE la.id = loan_application_events.loan_application_id
        AND la.user_id = (SELECT auth.uid())
    )
  )
);

CREATE POLICY "Loan withdrawals: owner or admin read"
ON public.loan_withdrawal_requests
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()) OR public.is_admin());

CREATE POLICY "Loan withdrawal events: visible to owner or admin"
ON public.loan_withdrawal_events
FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    customer_visible = TRUE
    AND EXISTS (
      SELECT 1 FROM public.loan_withdrawal_requests AS wr
      WHERE wr.id = loan_withdrawal_events.withdrawal_request_id
        AND wr.user_id = (SELECT auth.uid())
    )
  )
);

-- Mutations must use guarded RPC functions. No browser-side direct table writes.
REVOKE ALL ON TABLE public.loan_applications FROM anon, authenticated;
REVOKE ALL ON TABLE public.loan_application_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.loan_withdrawal_requests FROM anon, authenticated;
REVOKE ALL ON TABLE public.loan_withdrawal_events FROM anon, authenticated;

GRANT SELECT ON TABLE public.loan_applications TO authenticated;
GRANT SELECT ON TABLE public.loan_application_events TO authenticated;
GRANT SELECT ON TABLE public.loan_withdrawal_requests TO authenticated;
GRANT SELECT ON TABLE public.loan_withdrawal_events TO authenticated;

COMMIT;

-- NOTES FOR IMPLEMENTATION:
-- * Loan approval is not the same as disbursement.
-- * This initial version requests withdrawal of the full approved amount.
-- * A customer must have an active account and verified identity to request withdrawal.
-- * Bank/crypto transfer is handled outside this schema; the admin marks paid only
--   after independently confirming the transfer and entering a transaction reference.
-- * Before production, review local lending, privacy, KYC, sanctions, and payment rules.
