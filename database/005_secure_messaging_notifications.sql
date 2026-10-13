-- ============================================================
-- REFUND PLATFORM - SECURE CLAIM MESSAGING & NOTIFICATIONS
-- Migration 005. Requires migrations 001 through 004.
-- Messages are customer/staff visible. Private staff notes remain in claim_activity.
-- Notifications are in-app only; no email/SMS/push provider is configured here.
-- ============================================================

BEGIN;

-- 1. CLAIM MESSAGES
CREATE TABLE IF NOT EXISTS public.claim_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE RESTRICT,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claim_messages_claim_created_idx
  ON public.claim_messages (claim_id, created_at ASC);
CREATE INDEX IF NOT EXISTS claim_messages_sender_created_idx
  ON public.claim_messages (sender_id, created_at DESC);

-- 2. MESSAGE READ RECEIPTS
CREATE TABLE IF NOT EXISTS public.claim_message_reads (
  message_id UUID NOT NULL REFERENCES public.claim_messages(id) ON DELETE RESTRICT,
  reader_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, reader_id)
);

CREATE INDEX IF NOT EXISTS claim_message_reads_reader_idx
  ON public.claim_message_reads (reader_id, read_at DESC);

-- 3. IN-APP NOTIFICATIONS
CREATE TABLE IF NOT EXISTS public.user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'claim_message',
    'claim_update',
    'loan_update',
    'loan_withdrawal_update',
    'recovery_payout_update'
  )),
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 600),
  related_claim_id UUID REFERENCES public.claims(id) ON DELETE SET NULL,
  related_loan_application_id UUID REFERENCES public.loan_applications(id) ON DELETE SET NULL,
  related_loan_withdrawal_request_id UUID REFERENCES public.loan_withdrawal_requests(id) ON DELETE SET NULL,
  related_payout_request_id UUID REFERENCES public.payout_requests(id) ON DELETE SET NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notification_read_consistent CHECK (
    (is_read = FALSE AND read_at IS NULL) OR (is_read = TRUE AND read_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS user_notifications_recipient_created_idx
  ON public.user_notifications (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_notifications_unread_idx
  ON public.user_notifications (recipient_id, created_at DESC)
  WHERE is_read = FALSE;

-- 4. SEND A CLAIM MESSAGE THROUGH A VALIDATED SERVER-SIDE FUNCTION
CREATE OR REPLACE FUNCTION public.send_claim_message(
  p_claim_id UUID,
  p_body TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_sender UUID := auth.uid();
  v_owner UUID;
  v_assignee UUID;
  v_case_reference TEXT;
  v_message_id UUID;
  v_is_staff BOOLEAN := FALSE;
  v_clean_body TEXT;
BEGIN
  IF v_sender IS NULL THEN
    RAISE EXCEPTION 'Sign in before sending a message.' USING ERRCODE = '42501';
  END IF;

  v_clean_body := trim(COALESCE(p_body, ''));
  IF char_length(v_clean_body) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Messages must contain between 1 and 5000 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT c.user_id, c.assigned_to, c.case_reference
    INTO v_owner, v_assignee, v_case_reference
  FROM public.claims AS c
  WHERE c.id = p_claim_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.' USING ERRCODE = 'P0002';
  END IF;

  v_is_staff := public.is_admin()
    OR public.has_app_role('support_agent'::public.app_role)
    OR (v_assignee = v_sender AND public.has_app_role('investigator'::public.app_role));

  IF v_sender <> v_owner AND NOT v_is_staff THEN
    RAISE EXCEPTION 'You are not permitted to message on this claim.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.claim_messages (claim_id, sender_id, body)
  VALUES (p_claim_id, v_sender, v_clean_body)
  RETURNING id INTO v_message_id;

  -- Notify the claimant when a staff member sends a message.
  IF v_sender <> v_owner THEN
    INSERT INTO public.user_notifications (
      recipient_id, notification_type, title, body, related_claim_id
    ) VALUES (
      v_owner,
      'claim_message',
      'New message from the Refund team',
      'The Refund team sent a message on case ' || v_case_reference || '.',
      p_claim_id
    );
  ELSE
    -- Notify the assigned investigator, if any.
    IF v_assignee IS NOT NULL AND v_assignee <> v_sender THEN
      INSERT INTO public.user_notifications (
        recipient_id, notification_type, title, body, related_claim_id
      ) VALUES (
        v_assignee,
        'claim_message',
        'New customer message',
        'A customer sent a message on case ' || v_case_reference || '.',
        p_claim_id
      );
    END IF;

    -- Notify administrators. If there is no assignee, notify support as well.
    INSERT INTO public.user_notifications (
      recipient_id, notification_type, title, body, related_claim_id
    )
    SELECT DISTINCT ur.user_id,
      'claim_message',
      'New customer message',
      'A customer sent a message on case ' || v_case_reference || '.',
      p_claim_id
    FROM public.user_roles AS ur
    WHERE ur.user_id <> v_sender
      AND (
        ur.role IN ('admin'::public.app_role, 'super_admin'::public.app_role)
        OR (v_assignee IS NULL AND ur.role = 'support_agent'::public.app_role)
      )
      AND ur.user_id IS DISTINCT FROM v_assignee;
  END IF;

  RETURN v_message_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.send_claim_message(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_claim_message(UUID, TEXT) TO authenticated;

-- 5. MARK MESSAGES READ FOR A CLAIM
CREATE OR REPLACE FUNCTION public.mark_claim_messages_read(p_claim_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_owner UUID;
  v_assignee UUID;
  v_is_staff BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;

  SELECT c.user_id, c.assigned_to
    INTO v_owner, v_assignee
  FROM public.claims AS c
  WHERE c.id = p_claim_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.' USING ERRCODE = 'P0002';
  END IF;

  v_is_staff := public.is_admin()
    OR public.has_app_role('support_agent'::public.app_role)
    OR (v_assignee = auth.uid() AND public.has_app_role('investigator'::public.app_role));

  IF auth.uid() <> v_owner AND NOT v_is_staff THEN
    RAISE EXCEPTION 'You are not permitted to read this conversation.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.claim_message_reads (message_id, reader_id)
  SELECT cm.id, auth.uid()
  FROM public.claim_messages AS cm
  WHERE cm.claim_id = p_claim_id
    AND cm.sender_id <> auth.uid()
  ON CONFLICT (message_id, reader_id) DO NOTHING;
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_claim_messages_read(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_claim_messages_read(UUID) TO authenticated;

-- 6. MARK ONE OR ALL NOTIFICATIONS READ
CREATE OR REPLACE FUNCTION public.mark_notification_read(p_notification_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.user_notifications
  SET is_read = TRUE, read_at = COALESCE(read_at, now())
  WHERE id = p_notification_id
    AND recipient_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Notification not found.' USING ERRCODE = 'P0002';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.user_notifications
  SET is_read = TRUE, read_at = COALESCE(read_at, now())
  WHERE recipient_id = auth.uid() AND is_read = FALSE;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_notification_read(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_all_notifications_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read() TO authenticated;

-- 7. NOTIFY CUSTOMER WHEN A CUSTOMER-VISIBLE CLAIM ACTIVITY IS ADDED
CREATE OR REPLACE FUNCTION public.notify_on_claim_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_owner UUID;
  v_reference TEXT;
BEGIN
  IF NEW.visibility <> 'customer'::public.claim_activity_visibility THEN
    RETURN NEW;
  END IF;

  SELECT c.user_id, c.case_reference
    INTO v_owner, v_reference
  FROM public.claims AS c
  WHERE c.id = NEW.claim_id;

  IF v_owner IS NOT NULL AND NEW.actor_id IS DISTINCT FROM v_owner THEN
    INSERT INTO public.user_notifications (
      recipient_id, notification_type, title, body, related_claim_id
    ) VALUES (
      v_owner,
      'claim_update',
      'Your claim has been updated',
      left(COALESCE(NULLIF(trim(NEW.body), ''), 'There is a new update on case ' || v_reference || '.'), 600),
      NEW.claim_id
    );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS claim_activity_notify_customer ON public.claim_activity;
CREATE TRIGGER claim_activity_notify_customer
AFTER INSERT ON public.claim_activity
FOR EACH ROW EXECUTE FUNCTION public.notify_on_claim_activity();

REVOKE ALL ON FUNCTION public.notify_on_claim_activity() FROM PUBLIC, anon, authenticated;

-- 8. NOTIFY CUSTOMER WHEN LOAN APPLICATION STATUS CHANGES
CREATE OR REPLACE FUNCTION public.notify_on_loan_application_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_owner UUID;
BEGIN
  IF NEW.customer_visible IS NOT TRUE THEN RETURN NEW; END IF;

  SELECT la.user_id INTO v_owner
  FROM public.loan_applications AS la
  WHERE la.id = NEW.loan_application_id;

  IF v_owner IS NOT NULL AND NEW.actor_id IS DISTINCT FROM v_owner THEN
    INSERT INTO public.user_notifications (
      recipient_id, notification_type, title, body, related_loan_application_id
    ) VALUES (
      v_owner,
      'loan_update',
      'Loan application update',
      left(NEW.event_note, 600),
      NEW.loan_application_id
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS loan_application_event_notify_customer ON public.loan_application_events;
CREATE TRIGGER loan_application_event_notify_customer
AFTER INSERT ON public.loan_application_events
FOR EACH ROW EXECUTE FUNCTION public.notify_on_loan_application_event();
REVOKE ALL ON FUNCTION public.notify_on_loan_application_event() FROM PUBLIC, anon, authenticated;

-- 9. NOTIFY CUSTOMER WHEN LOAN WITHDRAWAL STATUS CHANGES
CREATE OR REPLACE FUNCTION public.notify_on_loan_withdrawal_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_owner UUID;
BEGIN
  IF NEW.customer_visible IS NOT TRUE THEN RETURN NEW; END IF;

  SELECT wr.user_id INTO v_owner
  FROM public.loan_withdrawal_requests AS wr
  WHERE wr.id = NEW.withdrawal_request_id;

  IF v_owner IS NOT NULL AND NEW.actor_id IS DISTINCT FROM v_owner THEN
    INSERT INTO public.user_notifications (
      recipient_id, notification_type, title, body, related_loan_withdrawal_request_id
    ) VALUES (
      v_owner,
      'loan_withdrawal_update',
      'Loan withdrawal update',
      left(NEW.event_note, 600),
      NEW.withdrawal_request_id
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS loan_withdrawal_event_notify_customer ON public.loan_withdrawal_events;
CREATE TRIGGER loan_withdrawal_event_notify_customer
AFTER INSERT ON public.loan_withdrawal_events
FOR EACH ROW EXECUTE FUNCTION public.notify_on_loan_withdrawal_event();
REVOKE ALL ON FUNCTION public.notify_on_loan_withdrawal_event() FROM PUBLIC, anon, authenticated;

-- 10. NOTIFY CUSTOMER WHEN RECOVERY PAYOUT REQUEST STATUS CHANGES
CREATE OR REPLACE FUNCTION public.notify_on_payout_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_owner UUID;
BEGIN
  SELECT pr.user_id INTO v_owner
  FROM public.payout_requests AS pr
  WHERE pr.id = NEW.payout_request_id;

  IF v_owner IS NOT NULL AND NEW.actor_id IS DISTINCT FROM v_owner THEN
    INSERT INTO public.user_notifications (
      recipient_id, notification_type, title, body, related_payout_request_id
    ) VALUES (
      v_owner,
      'recovery_payout_update',
      'Recovery payout update',
      'Your recovery payout request status is now ' || replace(NEW.new_status::text, '_', ' ') || '.',
      NEW.payout_request_id
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS payout_event_notify_customer ON public.payout_events;
CREATE TRIGGER payout_event_notify_customer
AFTER INSERT ON public.payout_events
FOR EACH ROW EXECUTE FUNCTION public.notify_on_payout_event();
REVOKE ALL ON FUNCTION public.notify_on_payout_event() FROM PUBLIC, anon, authenticated;

-- 11. ROW LEVEL SECURITY
ALTER TABLE public.claim_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_message_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Claim messages: read permitted conversations" ON public.claim_messages;
DROP POLICY IF EXISTS "Claim message reads: read own receipts" ON public.claim_message_reads;
DROP POLICY IF EXISTS "Notifications: read own" ON public.user_notifications;

CREATE POLICY "Claim messages: read permitted conversations"
ON public.claim_messages
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.claims AS c
    WHERE c.id = claim_messages.claim_id
      AND (
        c.user_id = (SELECT auth.uid())
        OR public.is_admin()
        OR public.has_app_role('support_agent'::public.app_role)
        OR (
          c.assigned_to = (SELECT auth.uid())
          AND public.has_app_role('investigator'::public.app_role)
        )
      )
  )
);

CREATE POLICY "Claim message reads: read own receipts"
ON public.claim_message_reads
FOR SELECT TO authenticated
USING (reader_id = (SELECT auth.uid()));

CREATE POLICY "Notifications: read own"
ON public.user_notifications
FOR SELECT TO authenticated
USING (recipient_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.claim_messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.claim_message_reads FROM anon, authenticated;
REVOKE ALL ON TABLE public.user_notifications FROM anon, authenticated;

GRANT SELECT ON TABLE public.claim_messages TO authenticated;
GRANT SELECT ON TABLE public.claim_message_reads TO authenticated;
GRANT SELECT ON TABLE public.user_notifications TO authenticated;

COMMIT;
