-- ============================================================
-- REFUND PLATFORM - SUPPORT & COMPLAINTS
-- Migration 006. Requires migrations 001 through 005.
-- Private staff-only replies are never returned to customers.
-- ============================================================

BEGIN;

-- 1. TYPES
DO $$ BEGIN
  CREATE TYPE public.support_ticket_category AS ENUM (
    'general', 'account_access', 'identity_verification', 'claim_issue',
    'recovery_payout', 'loan_application', 'loan_withdrawal',
    'complaint', 'privacy_request', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TYPE public.support_ticket_status AS ENUM (
    'open', 'in_progress', 'waiting_for_customer', 'escalated', 'resolved', 'closed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TYPE public.support_ticket_priority AS ENUM ('low', 'normal', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TYPE public.support_message_visibility AS ENUM ('customer', 'internal');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$ LANGUAGE plpgsql;

-- 2. TICKETS
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_reference TEXT NOT NULL UNIQUE DEFAULT (
    'SUP-' || to_char(now(), 'YYYY') || '-' ||
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  ),
  customer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  customer_email TEXT,
  subject TEXT NOT NULL CHECK (char_length(trim(subject)) BETWEEN 5 AND 180),
  category public.support_ticket_category NOT NULL DEFAULT 'general',
  status public.support_ticket_status NOT NULL DEFAULT 'open',
  priority public.support_ticket_priority NOT NULL DEFAULT 'normal',
  related_claim_id UUID REFERENCES public.claims(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS support_tickets_customer_created_idx
  ON public.support_tickets (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_status_priority_created_idx
  ON public.support_tickets (status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_assignee_status_idx
  ON public.support_tickets (assigned_to, status, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_related_claim_idx
  ON public.support_tickets (related_claim_id);

-- 3. MESSAGES. 'internal' messages are visible only to permitted staff.
CREATE TABLE IF NOT EXISTS public.support_ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE RESTRICT,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 5000),
  visibility public.support_message_visibility NOT NULL DEFAULT 'customer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_ticket_messages_ticket_created_idx
  ON public.support_ticket_messages (ticket_id, created_at ASC);

-- 4. AUDIT EVENTS
CREATE TABLE IF NOT EXISTS public.support_ticket_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE RESTRICT,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'ticket_created', 'message_added', 'status_changed', 'priority_changed',
    'assignment_changed', 'customer_escalated', 'ticket_reopened'
  )),
  old_status public.support_ticket_status,
  new_status public.support_ticket_status,
  old_priority public.support_ticket_priority,
  new_priority public.support_ticket_priority,
  old_assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  new_assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_note TEXT CHECK (event_note IS NULL OR char_length(event_note) <= 5000),
  customer_visible BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_ticket_events_ticket_created_idx
  ON public.support_ticket_events (ticket_id, created_at ASC);

-- 5. EXTEND IN-APP NOTIFICATIONS FOR SUPPORT TICKETS.
ALTER TABLE public.user_notifications
  ADD COLUMN IF NOT EXISTS related_support_ticket_id UUID
  REFERENCES public.support_tickets(id) ON DELETE SET NULL;

ALTER TABLE public.user_notifications
  DROP CONSTRAINT IF EXISTS user_notifications_notification_type_check;
ALTER TABLE public.user_notifications
  ADD CONSTRAINT user_notifications_notification_type_check CHECK (notification_type IN (
    'claim_message', 'claim_update', 'loan_update', 'loan_withdrawal_update',
    'recovery_payout_update', 'support_ticket_created', 'support_ticket_message',
    'support_ticket_update'
  ));

CREATE INDEX IF NOT EXISTS user_notifications_support_ticket_idx
  ON public.user_notifications (recipient_id, related_support_ticket_id, created_at DESC);

-- 6. CREATE TICKET. Claim linkage is accepted only when the customer owns the claim.
CREATE OR REPLACE FUNCTION public.create_support_ticket(
  p_category public.support_ticket_category,
  p_subject TEXT,
  p_initial_message TEXT,
  p_related_claim_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_email TEXT;
  v_subject TEXT := trim(COALESCE(p_subject, ''));
  v_message TEXT := trim(COALESCE(p_initial_message, ''));
  v_ticket_id UUID;
  v_reference TEXT;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Sign in before creating a support ticket.' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_subject) NOT BETWEEN 5 AND 180 THEN
    RAISE EXCEPTION 'Subject must contain between 5 and 180 characters.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_message) NOT BETWEEN 10 AND 5000 THEN
    RAISE EXCEPTION 'Describe the issue in 10 to 5000 characters.' USING ERRCODE = '22023';
  END IF;

  IF p_related_claim_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.claims c
    WHERE c.id = p_related_claim_id AND c.user_id = v_user
  ) THEN
    RAISE EXCEPTION 'You can only link a claim that belongs to your account.' USING ERRCODE = '42501';
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_user;

  INSERT INTO public.support_tickets (
    customer_id, customer_email, subject, category, related_claim_id
  ) VALUES (
    v_user, v_email, v_subject, p_category, p_related_claim_id
  ) RETURNING id, ticket_reference INTO v_ticket_id, v_reference;

  INSERT INTO public.support_ticket_messages (ticket_id, sender_id, body, visibility)
  VALUES (v_ticket_id, v_user, v_message, 'customer'::public.support_message_visibility);

  INSERT INTO public.support_ticket_events (
    ticket_id, actor_id, event_type, new_status, new_priority, event_note, customer_visible
  ) VALUES (
    v_ticket_id, v_user, 'ticket_created', 'open'::public.support_ticket_status,
    'normal'::public.support_ticket_priority, 'Support request created.', TRUE
  );

  -- Notify admins and support agents; never send a notification to the customer here.
  INSERT INTO public.user_notifications (
    recipient_id, notification_type, title, body, related_support_ticket_id
  )
  SELECT DISTINCT ur.user_id, 'support_ticket_created', 'New support request',
         'A new support request (' || v_reference || ') needs review.', v_ticket_id
  FROM public.user_roles ur
  WHERE ur.user_id <> v_user
    AND ur.role IN ('admin'::public.app_role, 'super_admin'::public.app_role,
                    'support_agent'::public.app_role);

  RETURN v_ticket_id;
END;
$function$;

-- 7. SEND A MESSAGE OR STAFF-ONLY INTERNAL NOTE.
CREATE OR REPLACE FUNCTION public.reply_support_ticket(
  p_ticket_id UUID,
  p_body TEXT,
  p_visibility public.support_message_visibility DEFAULT 'customer'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_owner UUID;
  v_assignee UUID;
  v_status public.support_ticket_status;
  v_reference TEXT;
  v_is_admin_or_support BOOLEAN;
  v_is_assigned_investigator BOOLEAN;
  v_body TEXT := trim(COALESCE(p_body, ''));
  v_message_id UUID;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_body) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Messages must contain between 1 and 5000 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT t.customer_id, t.assigned_to, t.status, t.ticket_reference
    INTO v_owner, v_assignee, v_status, v_reference
  FROM public.support_tickets t WHERE t.id = p_ticket_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support ticket not found.' USING ERRCODE = 'P0002';
  END IF;

  v_is_admin_or_support := public.is_admin()
    OR public.has_app_role('support_agent'::public.app_role);
  v_is_assigned_investigator := v_assignee = v_user
    AND public.has_app_role('investigator'::public.app_role);

  IF v_user <> v_owner AND NOT v_is_admin_or_support AND NOT v_is_assigned_investigator THEN
    RAISE EXCEPTION 'You are not permitted to reply to this ticket.' USING ERRCODE = '42501';
  END IF;
  IF v_user = v_owner AND p_visibility <> 'customer'::public.support_message_visibility THEN
    RAISE EXCEPTION 'Customers cannot create internal notes.' USING ERRCODE = '42501';
  END IF;
  IF v_status = 'closed'::public.support_ticket_status AND v_user = v_owner THEN
    RAISE EXCEPTION 'This ticket is closed. Open a new ticket for additional help.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.support_ticket_messages (ticket_id, sender_id, body, visibility)
  VALUES (p_ticket_id, v_user, v_body, p_visibility)
  RETURNING id INTO v_message_id;

  IF v_user = v_owner THEN
    -- A customer reply reopens a resolved ticket and leaves an audit event.
    IF v_status = 'resolved'::public.support_ticket_status THEN
      UPDATE public.support_tickets
      SET status = 'open'::public.support_ticket_status, resolved_at = NULL,
          updated_at = now()
      WHERE id = p_ticket_id;
      INSERT INTO public.support_ticket_events (
        ticket_id, actor_id, event_type, old_status, new_status, event_note, customer_visible
      ) VALUES (
        p_ticket_id, v_user, 'ticket_reopened', v_status,
        'open'::public.support_ticket_status,
        'Customer replied to a resolved ticket.', TRUE
      );
    ELSE
      UPDATE public.support_tickets SET updated_at = now() WHERE id = p_ticket_id;
    END IF;

    INSERT INTO public.user_notifications (
      recipient_id, notification_type, title, body, related_support_ticket_id
    )
    SELECT targets.user_id, 'support_ticket_message', 'New customer support reply',
      'A customer replied to support request ' || v_reference || '.', p_ticket_id
    FROM (
      SELECT ur.user_id
      FROM public.user_roles ur
      WHERE ur.role IN ('admin'::public.app_role, 'super_admin'::public.app_role,
                        'support_agent'::public.app_role)
      UNION
      SELECT v_assignee WHERE v_assignee IS NOT NULL
    ) targets
    WHERE targets.user_id <> v_user;
  ELSE
    UPDATE public.support_tickets SET updated_at = now() WHERE id = p_ticket_id;
    IF p_visibility = 'customer'::public.support_message_visibility THEN
      INSERT INTO public.user_notifications (
        recipient_id, notification_type, title, body, related_support_ticket_id
      ) VALUES (
        v_owner, 'support_ticket_message', 'New support reply',
        'The Refund team replied to support request ' || v_reference || '.', p_ticket_id
      );
    END IF;
  END IF;

  INSERT INTO public.support_ticket_events (
    ticket_id, actor_id, event_type, event_note, customer_visible
  ) VALUES (
    p_ticket_id, v_user, 'message_added',
    CASE WHEN p_visibility = 'customer'::public.support_message_visibility
         THEN 'A reply was added.' ELSE 'An internal note was added.' END,
    p_visibility = 'customer'::public.support_message_visibility
  );

  RETURN v_message_id;
END;
$function$;

-- 8. STAFF UPDATE STATUS, PRIORITY, ASSIGNEE. Investigator may update only own assigned ticket status.
CREATE OR REPLACE FUNCTION public.staff_update_support_ticket(
  p_ticket_id UUID,
  p_status public.support_ticket_status,
  p_priority public.support_ticket_priority,
  p_assigned_to UUID,
  p_customer_note TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_owner UUID;
  v_reference TEXT;
  v_old_status public.support_ticket_status;
  v_old_priority public.support_ticket_priority;
  v_old_assignee UUID;
  v_admin_or_support BOOLEAN;
  v_assigned_investigator BOOLEAN;
  v_note TEXT := NULLIF(trim(COALESCE(p_customer_note, '')), '');
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;

  SELECT t.customer_id, t.ticket_reference, t.status, t.priority, t.assigned_to
    INTO v_owner, v_reference, v_old_status, v_old_priority, v_old_assignee
  FROM public.support_tickets t WHERE t.id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support ticket not found.' USING ERRCODE = 'P0002';
  END IF;

  v_admin_or_support := public.is_admin()
    OR public.has_app_role('support_agent'::public.app_role);
  v_assigned_investigator := v_old_assignee = v_user
    AND public.has_app_role('investigator'::public.app_role);

  IF NOT v_admin_or_support AND NOT v_assigned_investigator THEN
    RAISE EXCEPTION 'Staff permissions are required.' USING ERRCODE = '42501';
  END IF;

  IF NOT v_admin_or_support THEN
    IF p_priority IS DISTINCT FROM v_old_priority
       OR p_assigned_to IS DISTINCT FROM v_old_assignee THEN
      RAISE EXCEPTION 'Investigators cannot change ticket priority or assignment.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_assigned_to IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p_assigned_to
      AND ur.role IN ('admin'::public.app_role, 'super_admin'::public.app_role,
                      'support_agent'::public.app_role, 'investigator'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'The assignee must have an authorized staff role.' USING ERRCODE = '22023';
  END IF;

  IF p_status IN ('resolved'::public.support_ticket_status, 'closed'::public.support_ticket_status)
     AND v_note IS NULL THEN
    RAISE EXCEPTION 'Add a customer-visible explanation when resolving or closing a ticket.' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 5000 THEN
    RAISE EXCEPTION 'Customer update must be 5000 characters or fewer.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.support_tickets
  SET status = p_status,
      priority = p_priority,
      assigned_to = p_assigned_to,
      updated_at = now(),
      resolved_at = CASE WHEN p_status = 'resolved'::public.support_ticket_status
                         THEN COALESCE(resolved_at, now()) ELSE NULL END,
      closed_at = CASE WHEN p_status = 'closed'::public.support_ticket_status
                       THEN COALESCE(closed_at, now()) ELSE NULL END
  WHERE id = p_ticket_id;

  IF v_old_status IS DISTINCT FROM p_status THEN
    INSERT INTO public.support_ticket_events (
      ticket_id, actor_id, event_type, old_status, new_status, event_note, customer_visible
    ) VALUES (
      p_ticket_id, v_user, 'status_changed', v_old_status, p_status, v_note, v_note IS NOT NULL
    );
  END IF;
  IF v_old_priority IS DISTINCT FROM p_priority THEN
    INSERT INTO public.support_ticket_events (
      ticket_id, actor_id, event_type, old_priority, new_priority, event_note, customer_visible
    ) VALUES (
      p_ticket_id, v_user, 'priority_changed', v_old_priority, p_priority,
      'Ticket priority changed.', FALSE
    );
  END IF;
  IF v_old_assignee IS DISTINCT FROM p_assigned_to THEN
    INSERT INTO public.support_ticket_events (
      ticket_id, actor_id, event_type, old_assigned_to, new_assigned_to, event_note, customer_visible
    ) VALUES (
      p_ticket_id, v_user, 'assignment_changed', v_old_assignee, p_assigned_to,
      'Ticket assignment changed.', FALSE
    );
  END IF;

  IF v_note IS NOT NULL THEN
    INSERT INTO public.support_ticket_messages (ticket_id, sender_id, body, visibility)
    VALUES (p_ticket_id, v_user, v_note, 'customer'::public.support_message_visibility);
    INSERT INTO public.user_notifications (
      recipient_id, notification_type, title, body, related_support_ticket_id
    ) VALUES (
      v_owner, 'support_ticket_update', 'Support request updated',
      left(v_note, 600), p_ticket_id
    );
  END IF;
END;
$function$;

-- 9. CUSTOMER ESCALATION REQUEST.
CREATE OR REPLACE FUNCTION public.customer_escalate_support_ticket(
  p_ticket_id UUID,
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_owner UUID;
  v_status public.support_ticket_status;
  v_reference TEXT;
  v_reason TEXT := trim(COALESCE(p_reason, ''));
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'Explain the escalation request in 10 to 2000 characters.' USING ERRCODE = '22023';
  END IF;
  SELECT t.customer_id, t.status, t.ticket_reference
    INTO v_owner, v_status, v_reference
  FROM public.support_tickets t WHERE t.id = p_ticket_id FOR UPDATE;
  IF NOT FOUND OR v_owner <> v_user THEN
    RAISE EXCEPTION 'Support ticket not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_status IN ('closed'::public.support_ticket_status, 'resolved'::public.support_ticket_status) THEN
    RAISE EXCEPTION 'Resolved or closed tickets cannot be escalated. Reply to a resolved ticket to reopen it or open a new ticket.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.support_tickets
  SET status = 'escalated'::public.support_ticket_status, updated_at = now()
  WHERE id = p_ticket_id;

  INSERT INTO public.support_ticket_messages (ticket_id, sender_id, body, visibility)
  VALUES (p_ticket_id, v_user, 'Escalation request: ' || v_reason,
          'customer'::public.support_message_visibility);
  INSERT INTO public.support_ticket_events (
    ticket_id, actor_id, event_type, old_status, new_status, event_note, customer_visible
  ) VALUES (
    p_ticket_id, v_user, 'customer_escalated', v_status,
    'escalated'::public.support_ticket_status, v_reason, TRUE
  );

  INSERT INTO public.user_notifications (
    recipient_id, notification_type, title, body, related_support_ticket_id
  )
  SELECT DISTINCT ur.user_id, 'support_ticket_update', 'Support ticket escalated',
         'A customer requested escalation for support request ' || v_reference || '.', p_ticket_id
  FROM public.user_roles ur
  WHERE ur.user_id <> v_user
    AND ur.role IN ('admin'::public.app_role, 'super_admin'::public.app_role,
                    'support_agent'::public.app_role);
END;
$function$;

-- 10. LIST ASSIGNABLE STAFF FOR AUTHORIZED SUPPORT USERS.
CREATE OR REPLACE FUNCTION public.list_support_assignees()
RETURNS TABLE (user_id UUID, full_name TEXT, email TEXT, role public.app_role)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.is_admin() OR public.has_app_role('support_agent'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Support staff access required.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT ur.user_id,
         COALESCE(p.full_name, 'Staff member')::TEXT,
         au.email::TEXT,
         ur.role
  FROM public.user_roles ur
  JOIN auth.users au ON au.id = ur.user_id
  LEFT JOIN public.profiles p ON p.id = ur.user_id
  WHERE ur.role IN ('admin'::public.app_role, 'super_admin'::public.app_role,
                    'support_agent'::public.app_role, 'investigator'::public.app_role)
  ORDER BY p.full_name NULLS LAST, au.email;
END;
$function$;

-- 11. TOUCH UPDATED_AT
CREATE OR REPLACE FUNCTION public.touch_support_ticket_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS support_ticket_updated_at ON public.support_tickets;
CREATE TRIGGER support_ticket_updated_at
BEFORE UPDATE ON public.support_tickets
FOR EACH ROW EXECUTE FUNCTION public.touch_support_ticket_updated_at();

-- 12. ROW LEVEL SECURITY
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Support tickets: permitted reader" ON public.support_tickets;
CREATE POLICY "Support tickets: permitted reader"
ON public.support_tickets FOR SELECT TO authenticated
USING (
  customer_id = (SELECT auth.uid())
  OR public.is_admin()
  OR public.has_app_role('support_agent'::public.app_role)
  OR (assigned_to = (SELECT auth.uid()) AND public.has_app_role('investigator'::public.app_role))
);

DROP POLICY IF EXISTS "Support messages: permitted reader" ON public.support_ticket_messages;
CREATE POLICY "Support messages: permitted reader"
ON public.support_ticket_messages FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.support_tickets t
    WHERE t.id = support_ticket_messages.ticket_id
      AND (
        (t.customer_id = (SELECT auth.uid())
          AND support_ticket_messages.visibility = 'customer'::public.support_message_visibility)
        OR public.is_admin()
        OR public.has_app_role('support_agent'::public.app_role)
        OR (t.assigned_to = (SELECT auth.uid())
            AND public.has_app_role('investigator'::public.app_role))
      )
  )
);

DROP POLICY IF EXISTS "Support events: permitted reader" ON public.support_ticket_events;
CREATE POLICY "Support events: permitted reader"
ON public.support_ticket_events FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.support_tickets t
    WHERE t.id = support_ticket_events.ticket_id
      AND (
        (t.customer_id = (SELECT auth.uid()) AND support_ticket_events.customer_visible = TRUE)
        OR public.is_admin()
        OR public.has_app_role('support_agent'::public.app_role)
        OR (t.assigned_to = (SELECT auth.uid())
            AND public.has_app_role('investigator'::public.app_role))
      )
  )
);

REVOKE ALL ON TABLE public.support_tickets FROM anon, authenticated;
REVOKE ALL ON TABLE public.support_ticket_messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.support_ticket_events FROM anon, authenticated;
GRANT SELECT ON TABLE public.support_tickets TO authenticated;
GRANT SELECT ON TABLE public.support_ticket_messages TO authenticated;
GRANT SELECT ON TABLE public.support_ticket_events TO authenticated;

REVOKE ALL ON FUNCTION public.create_support_ticket(public.support_ticket_category, TEXT, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reply_support_ticket(UUID, TEXT, public.support_message_visibility) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_update_support_ticket(UUID, public.support_ticket_status, public.support_ticket_priority, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.customer_escalate_support_ticket(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_support_assignees() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_support_ticket(public.support_ticket_category, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reply_support_ticket(UUID, TEXT, public.support_message_visibility) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_update_support_ticket(UUID, public.support_ticket_status, public.support_ticket_priority, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_escalate_support_ticket(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_support_assignees() TO authenticated;

COMMIT;
