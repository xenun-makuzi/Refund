-- ============================================================
-- REFUND PLATFORM - RISK REVIEW + CONFIGURABLE CLAIM WORKFLOWS
-- Migration 007. Requires migrations 001 through 006.
-- Run this complete file in a NEW Supabase SQL Editor query.
-- Risk flags are admin-only; they are internal review indicators,
-- not conclusions that a customer has committed fraud.
-- Workflow stages are additional to the existing coarse claim status.
-- ============================================================

BEGIN;

-- 1. ENUMS
DO $$ BEGIN
  CREATE TYPE public.risk_flag_category AS ENUM (
    'duplicate_claim',
    'identity_mismatch',
    'inconsistent_evidence',
    'unusual_payout_destination',
    'suspicious_pattern',
    'manual_review',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TYPE public.risk_flag_severity AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TYPE public.risk_flag_status AS ENUM ('open', 'under_review', 'resolved', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$ LANGUAGE plpgsql;

-- 2. CONFIGURABLE WORKFLOW TEMPLATES
CREATE TABLE IF NOT EXISTS public.claim_workflow_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 3 AND 120),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 120),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 2000),
  applies_to_category public.claim_category,
  applies_to_origin public.claim_origin,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS claim_workflow_templates_slug_lower_uidx
  ON public.claim_workflow_templates (lower(slug));
CREATE INDEX IF NOT EXISTS claim_workflow_templates_active_idx
  ON public.claim_workflow_templates (is_active, created_at DESC);

CREATE TABLE IF NOT EXISTS public.claim_workflow_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES public.claim_workflow_templates(id) ON DELETE RESTRICT,
  step_key TEXT NOT NULL CHECK (step_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$' AND char_length(step_key) <= 80),
  label TEXT NOT NULL CHECK (char_length(trim(label)) BETWEEN 2 AND 120),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 200),
  customer_visible BOOLEAN NOT NULL DEFAULT TRUE,
  requires_evidence BOOLEAN NOT NULL DEFAULT FALSE,
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, step_key),
  UNIQUE (workflow_id, position)
);
CREATE INDEX IF NOT EXISTS claim_workflow_steps_position_idx
  ON public.claim_workflow_steps (workflow_id, position);

-- 3. WORKFLOW RUNS: one active workflow assignment per claim in v1.
CREATE TABLE IF NOT EXISTS public.claim_workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL UNIQUE REFERENCES public.claims(id) ON DELETE RESTRICT,
  workflow_id UUID NOT NULL REFERENCES public.claim_workflow_templates(id) ON DELETE RESTRICT,
  current_step_id UUID NOT NULL REFERENCES public.claim_workflow_steps(id) ON DELETE RESTRICT,
  started_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS claim_workflow_runs_workflow_idx
  ON public.claim_workflow_runs (workflow_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.claim_workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.claim_workflow_runs(id) ON DELETE RESTRICT,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE RESTRICT,
  workflow_step_id UUID NOT NULL REFERENCES public.claim_workflow_steps(id) ON DELETE RESTRICT,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('assigned', 'advanced', 'completed')),
  note TEXT NOT NULL CHECK (char_length(trim(note)) BETWEEN 1 AND 2000),
  customer_visible BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_workflow_events_run_created_idx
  ON public.claim_workflow_events (run_id, created_at ASC);

-- 4. RISK REVIEW FLAGS. Exactly one subject per flag.
CREATE TABLE IF NOT EXISTS public.risk_review_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID REFERENCES public.claims(id) ON DELETE RESTRICT,
  subject_user_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  loan_application_id UUID REFERENCES public.loan_applications(id) ON DELETE RESTRICT,
  category public.risk_flag_category NOT NULL,
  severity public.risk_flag_severity NOT NULL DEFAULT 'medium',
  summary TEXT NOT NULL CHECK (char_length(trim(summary)) BETWEEN 5 AND 300),
  details TEXT CHECK (details IS NULL OR char_length(details) <= 4000),
  status public.risk_flag_status NOT NULL DEFAULT 'open',
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  raised_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note TEXT CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 2000),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT risk_review_flags_exactly_one_subject CHECK (
    num_nonnulls(claim_id, subject_user_id, loan_application_id) = 1
  ),
  CONSTRAINT risk_review_flags_resolution_consistent CHECK (
    (status IN ('resolved'::public.risk_flag_status, 'dismissed'::public.risk_flag_status)
      AND resolved_at IS NOT NULL)
    OR
    (status NOT IN ('resolved'::public.risk_flag_status, 'dismissed'::public.risk_flag_status)
      AND resolved_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS risk_review_flags_status_created_idx
  ON public.risk_review_flags (status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS risk_review_flags_claim_idx
  ON public.risk_review_flags (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS risk_review_flags_subject_user_idx
  ON public.risk_review_flags (subject_user_id) WHERE subject_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS risk_review_flags_loan_idx
  ON public.risk_review_flags (loan_application_id) WHERE loan_application_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.risk_flag_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_flag_id UUID NOT NULL REFERENCES public.risk_review_flags(id) ON DELETE RESTRICT,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'assigned', 'status_changed')),
  previous_status public.risk_flag_status,
  new_status public.risk_flag_status NOT NULL,
  event_note TEXT NOT NULL CHECK (char_length(trim(event_note)) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_flag_events_flag_created_idx
  ON public.risk_flag_events (risk_flag_id, created_at ASC);

-- 5. CENTRAL ADMIN ACTION AUDIT STREAM. Do not put secrets or full financial credentials here.
CREATE TABLE IF NOT EXISTS public.security_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action_key TEXT NOT NULL CHECK (char_length(trim(action_key)) BETWEEN 3 AND 100),
  entity_type TEXT NOT NULL CHECK (char_length(trim(entity_type)) BETWEEN 2 AND 80),
  entity_id UUID,
  summary TEXT NOT NULL CHECK (char_length(trim(summary)) BETWEEN 3 AND 500),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_audit_events_created_idx
  ON public.security_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_events_actor_idx
  ON public.security_audit_events (actor_id, created_at DESC);

-- 6. UPDATED_AT TRIGGER FOR WORKFLOW TEMPLATES
CREATE OR REPLACE FUNCTION public.touch_claim_workflow_template()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.touch_claim_workflow_template() FROM PUBLIC, anon, authenticated;

-- Active workflow definitions must have stages and exactly one terminal final stage.
CREATE OR REPLACE FUNCTION public.validate_claim_workflow_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_step_count INTEGER;
  v_last_position INTEGER;
  v_terminal_count INTEGER;
  v_terminal_position INTEGER;
BEGIN
  IF NEW.is_active THEN
    SELECT count(*), max(position), count(*) FILTER (WHERE is_terminal),
           max(position) FILTER (WHERE is_terminal)
      INTO v_step_count, v_last_position, v_terminal_count, v_terminal_position
    FROM public.claim_workflow_steps
    WHERE workflow_id = NEW.id;

    IF COALESCE(v_step_count, 0) = 0 THEN
      RAISE EXCEPTION 'Add at least one stage before activating a workflow.' USING ERRCODE = '22023';
    END IF;
    IF v_terminal_count <> 1 OR v_terminal_position IS DISTINCT FROM v_last_position THEN
      RAISE EXCEPTION 'An active workflow must have exactly one final stage, at the last position.' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.validate_claim_workflow_activation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS claim_workflow_templates_validate_activation ON public.claim_workflow_templates;
CREATE TRIGGER claim_workflow_templates_validate_activation
BEFORE INSERT OR UPDATE ON public.claim_workflow_templates
FOR EACH ROW EXECUTE FUNCTION public.validate_claim_workflow_activation();

-- The stage sequence cannot be edited while its template is active.
CREATE OR REPLACE FUNCTION public.guard_active_claim_workflow_step_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.claim_workflow_templates t
    WHERE t.id = NEW.workflow_id AND t.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Deactivate the workflow before changing its stages.' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.workflow_id IS DISTINCT FROM NEW.workflow_id AND EXISTS (
      SELECT 1 FROM public.claim_workflow_templates t
      WHERE t.id = OLD.workflow_id AND t.is_active = TRUE
    ) THEN
      RAISE EXCEPTION 'Deactivate the original workflow before moving a stage.' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_active_claim_workflow_step_changes() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS claim_workflow_steps_guard_active ON public.claim_workflow_steps;
CREATE TRIGGER claim_workflow_steps_guard_active
BEFORE INSERT OR UPDATE ON public.claim_workflow_steps
FOR EACH ROW EXECUTE FUNCTION public.guard_active_claim_workflow_step_changes();

DROP TRIGGER IF EXISTS claim_workflow_templates_touch_updated_at ON public.claim_workflow_templates;
CREATE TRIGGER claim_workflow_templates_touch_updated_at
BEFORE UPDATE ON public.claim_workflow_templates
FOR EACH ROW EXECUTE FUNCTION public.touch_claim_workflow_template();

CREATE OR REPLACE FUNCTION public.touch_risk_review_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.touch_risk_review_flag() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS risk_review_flags_touch_updated_at ON public.risk_review_flags;
CREATE TRIGGER risk_review_flags_touch_updated_at
BEFORE UPDATE ON public.risk_review_flags
FOR EACH ROW EXECUTE FUNCTION public.touch_risk_review_flag();

-- 7. ADMIN ASSIGNS A WORKFLOW TO A CLAIM
CREATE OR REPLACE FUNCTION public.admin_assign_claim_workflow(
  p_claim_id UUID,
  p_workflow_id UUID,
  p_note TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_claim public.claims%ROWTYPE;
  v_workflow public.claim_workflow_templates%ROWTYPE;
  v_step public.claim_workflow_steps%ROWTYPE;
  v_run_id UUID;
  v_note TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can assign claim workflows.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_claim FROM public.claims WHERE id = p_claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_workflow
  FROM public.claim_workflow_templates
  WHERE id = p_workflow_id AND is_active = TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose an active workflow template.' USING ERRCODE = '22023';
  END IF;

  IF v_workflow.applies_to_category IS NOT NULL
     AND v_workflow.applies_to_category <> v_claim.category THEN
    RAISE EXCEPTION 'This workflow does not apply to the claim category.' USING ERRCODE = '22023';
  END IF;
  IF v_workflow.applies_to_origin IS NOT NULL
     AND v_workflow.applies_to_origin <> v_claim.origin THEN
    RAISE EXCEPTION 'This workflow does not apply to the claim origin.' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.claim_workflow_runs WHERE claim_id = p_claim_id) THEN
    RAISE EXCEPTION 'A workflow has already been assigned to this claim.' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_step
  FROM public.claim_workflow_steps
  WHERE workflow_id = p_workflow_id
  ORDER BY position ASC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Add at least one step before assigning this workflow.' USING ERRCODE = '22023';
  END IF;

  v_note := COALESCE(NULLIF(trim(COALESCE(p_note, '')), ''),
    'The case entered the workflow: ' || v_workflow.name || '.');
  v_note := left(v_note, 2000);

  INSERT INTO public.claim_workflow_runs (claim_id, workflow_id, current_step_id, started_by, completed_at)
  VALUES (p_claim_id, p_workflow_id, v_step.id, auth.uid(), CASE WHEN v_step.is_terminal THEN now() ELSE NULL END)
  RETURNING id INTO v_run_id;

  INSERT INTO public.claim_workflow_events (
    run_id, claim_id, workflow_step_id, actor_id, event_type, note, customer_visible
  ) VALUES (
    v_run_id, p_claim_id, v_step.id, auth.uid(), CASE WHEN v_step.is_terminal THEN 'completed' ELSE 'assigned' END, v_note, v_step.customer_visible
  );

  INSERT INTO public.claim_activity (
    claim_id, actor_id, activity_type, visibility, body
  ) VALUES (
    p_claim_id, auth.uid(),
    CASE WHEN v_step.customer_visible THEN 'status_change'::public.claim_activity_type
         ELSE 'internal_note'::public.claim_activity_type END,
    CASE WHEN v_step.customer_visible THEN 'customer'::public.claim_activity_visibility
         ELSE 'internal'::public.claim_activity_visibility END,
    CASE WHEN v_step.customer_visible THEN v_note
         ELSE 'Workflow assigned: ' || v_workflow.name || '. Internal stage: ' || v_step.label || '.' END
  );

  INSERT INTO public.security_audit_events (
    actor_id, action_key, entity_type, entity_id, summary, metadata
  ) VALUES (
    auth.uid(), 'claim_workflow.assigned', 'claim', p_claim_id,
    'Assigned workflow ' || v_workflow.slug || ' to case ' || v_claim.case_reference || '.',
    jsonb_build_object('workflow_id', p_workflow_id, 'run_id', v_run_id, 'step_key', v_step.step_key)
  );


  RETURN v_run_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_assign_claim_workflow(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_claim_workflow(UUID, UUID, TEXT) TO authenticated;

-- 8. ADMIN / ASSIGNED INVESTIGATOR ADVANCES THE WORKFLOW ONE STEP
CREATE OR REPLACE FUNCTION public.admin_advance_claim_workflow(
  p_run_id UUID,
  p_target_step_id UUID,
  p_note TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_run public.claim_workflow_runs%ROWTYPE;
  v_claim public.claims%ROWTYPE;
  v_current_step public.claim_workflow_steps%ROWTYPE;
  v_next_step public.claim_workflow_steps%ROWTYPE;
  v_target_step public.claim_workflow_steps%ROWTYPE;
  v_note TEXT;
  v_event_type TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in before updating a workflow.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_run FROM public.claim_workflow_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workflow run not found.' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_claim FROM public.claims WHERE id = v_run.claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_admin()
     AND NOT (public.has_app_role('investigator'::public.app_role) AND v_claim.assigned_to = auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator or the assigned investigator can advance this workflow.' USING ERRCODE = '42501';
  END IF;

  IF v_run.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This workflow is already complete.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_current_step FROM public.claim_workflow_steps WHERE id = v_run.current_step_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current workflow step is missing.' USING ERRCODE = 'P0002';
  END IF;
  IF v_current_step.is_terminal THEN
    RAISE EXCEPTION 'The current step is terminal; this workflow cannot advance.' USING ERRCODE = '22023';
  END IF;

  IF v_current_step.requires_evidence AND NOT EXISTS (
    SELECT 1
    FROM public.claim_evidence ce
    WHERE ce.claim_id = v_claim.id
      AND ce.review_status = 'accepted'::public.evidence_review_status
  ) THEN
    RAISE EXCEPTION 'This stage requires at least one accepted evidence document before the case can advance.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_next_step
  FROM public.claim_workflow_steps
  WHERE workflow_id = v_run.workflow_id AND position > v_current_step.position
  ORDER BY position ASC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No next step exists. Mark the last step as terminal.' USING ERRCODE = '22023';
  END IF;

  IF p_target_step_id IS DISTINCT FROM v_next_step.id THEN
    RAISE EXCEPTION 'Workflows must advance one step at a time.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_target_step FROM public.claim_workflow_steps WHERE id = p_target_step_id;
  v_note := COALESCE(NULLIF(trim(COALESCE(p_note, '')), ''), 'Case stage updated to: ' || v_target_step.label || '.');
  v_note := left(v_note, 2000);
  v_event_type := CASE WHEN v_target_step.is_terminal THEN 'completed' ELSE 'advanced' END;

  UPDATE public.claim_workflow_runs
  SET current_step_id = v_target_step.id,
      completed_at = CASE WHEN v_target_step.is_terminal THEN now() ELSE NULL END
  WHERE id = v_run.id;

  INSERT INTO public.claim_workflow_events (
    run_id, claim_id, workflow_step_id, actor_id, event_type, note, customer_visible
  ) VALUES (
    v_run.id, v_claim.id, v_target_step.id, auth.uid(), v_event_type, v_note, v_target_step.customer_visible
  );

  INSERT INTO public.claim_activity (
    claim_id, actor_id, activity_type, visibility, body
  ) VALUES (
    v_claim.id, auth.uid(),
    CASE WHEN v_target_step.customer_visible THEN 'status_change'::public.claim_activity_type
         ELSE 'internal_note'::public.claim_activity_type END,
    CASE WHEN v_target_step.customer_visible THEN 'customer'::public.claim_activity_visibility
         ELSE 'internal'::public.claim_activity_visibility END,
    CASE WHEN v_target_step.customer_visible THEN v_note
         ELSE 'Workflow stage updated internally to: ' || v_target_step.label || '. ' || v_note END
  );

  INSERT INTO public.security_audit_events (
    actor_id, action_key, entity_type, entity_id, summary, metadata
  ) VALUES (
    auth.uid(), 'claim_workflow.advanced', 'claim', v_claim.id,
    'Advanced case ' || v_claim.case_reference || ' to workflow stage ' || v_target_step.step_key || '.',
    jsonb_build_object('run_id', v_run.id, 'step_id', v_target_step.id, 'step_key', v_target_step.step_key, 'terminal', v_target_step.is_terminal)
  );

END;
$function$;
REVOKE ALL ON FUNCTION public.admin_advance_claim_workflow(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_advance_claim_workflow(UUID, UUID, TEXT) TO authenticated;

-- 9. ADMIN CREATES AN INTERNAL RISK REVIEW FLAG
CREATE OR REPLACE FUNCTION public.admin_create_risk_flag(
  p_claim_id UUID DEFAULT NULL,
  p_subject_user_id UUID DEFAULT NULL,
  p_loan_application_id UUID DEFAULT NULL,
  p_category public.risk_flag_category DEFAULT 'manual_review',
  p_severity public.risk_flag_severity DEFAULT 'medium',
  p_summary TEXT DEFAULT NULL,
  p_details TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_flag_id UUID;
  v_flag public.risk_review_flags%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can create a risk review flag.' USING ERRCODE = '42501';
  END IF;

  IF num_nonnulls(p_claim_id, p_subject_user_id, p_loan_application_id) <> 1 THEN
    RAISE EXCEPTION 'Select exactly one claim, customer, or loan application.' USING ERRCODE = '22023';
  END IF;
  IF p_category IS NULL OR p_severity IS NULL THEN
    RAISE EXCEPTION 'Select a risk category and severity.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(char_length(trim(p_summary)), 0) NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'The review summary must contain 5 to 300 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_details IS NOT NULL AND char_length(p_details) > 4000 THEN
    RAISE EXCEPTION 'Details must not exceed 4000 characters.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.risk_review_flags (
    claim_id, subject_user_id, loan_application_id,
    category, severity, summary, details, raised_by
  ) VALUES (
    p_claim_id, p_subject_user_id, p_loan_application_id,
    p_category, p_severity, trim(p_summary), NULLIF(trim(COALESCE(p_details, '')), ''), auth.uid()
  ) RETURNING id INTO v_flag_id;

  SELECT * INTO v_flag FROM public.risk_review_flags WHERE id = v_flag_id;
  INSERT INTO public.risk_flag_events (
    risk_flag_id, actor_id, event_type, previous_status, new_status, event_note
  ) VALUES (
    v_flag_id, auth.uid(), 'created', NULL, v_flag.status,
    'Risk review flag created for internal review: ' || v_flag.summary
  );

  INSERT INTO public.security_audit_events (
    actor_id, action_key, entity_type, entity_id, summary, metadata
  ) VALUES (
    auth.uid(), 'risk_flag.created', 'risk_flag', v_flag_id,
    'Created an internal risk review flag.',
    jsonb_build_object('category', p_category, 'severity', p_severity, 'claim_id', p_claim_id,
      'subject_user_id', p_subject_user_id, 'loan_application_id', p_loan_application_id)
  );

  RETURN v_flag_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_create_risk_flag(UUID, UUID, UUID, public.risk_flag_category, public.risk_flag_severity, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_risk_flag(UUID, UUID, UUID, public.risk_flag_category, public.risk_flag_severity, TEXT, TEXT) TO authenticated;

-- 10. ADMIN UPDATES / ASSIGNS / RESOLVES A RISK FLAG
CREATE OR REPLACE FUNCTION public.admin_update_risk_flag(
  p_flag_id UUID,
  p_new_status public.risk_flag_status,
  p_assigned_to UUID DEFAULT NULL,
  p_resolution_note TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_flag public.risk_review_flags%ROWTYPE;
  v_new_assignee UUID;
  v_note TEXT;
  v_action TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can update risk review flags.' USING ERRCODE = '42501';
  END IF;
  IF p_new_status IS NULL THEN
    RAISE EXCEPTION 'Choose a valid review status.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_flag FROM public.risk_review_flags WHERE id = p_flag_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Risk flag not found.' USING ERRCODE = 'P0002';
  END IF;

  v_new_assignee := COALESCE(p_assigned_to, v_flag.assigned_to);
  IF p_assigned_to IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.profiles pr ON pr.id = ur.user_id
    WHERE ur.user_id = p_assigned_to
      AND ur.role IN ('investigator'::public.app_role, 'admin'::public.app_role, 'super_admin'::public.app_role)
      AND pr.account_status = 'active'::public.account_status
  ) THEN
    RAISE EXCEPTION 'Assign this review to an active investigator or administrator.' USING ERRCODE = '22023';
  END IF;

  IF p_new_status IN ('resolved'::public.risk_flag_status, 'dismissed'::public.risk_flag_status)
     AND COALESCE(char_length(trim(p_resolution_note)), 0) < 5 THEN
    RAISE EXCEPTION 'Add a resolution note of at least 5 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_resolution_note IS NOT NULL AND char_length(p_resolution_note) > 2000 THEN
    RAISE EXCEPTION 'Resolution note must not exceed 2000 characters.' USING ERRCODE = '22023';
  END IF;

  v_note := COALESCE(NULLIF(trim(COALESCE(p_resolution_note, '')), ''), 'Risk review updated by an administrator.');
  v_action := CASE WHEN v_new_assignee IS DISTINCT FROM v_flag.assigned_to THEN 'assigned' ELSE 'status_changed' END;

  UPDATE public.risk_review_flags
  SET status = p_new_status,
      assigned_to = v_new_assignee,
      resolution_note = CASE WHEN p_new_status IN ('resolved'::public.risk_flag_status, 'dismissed'::public.risk_flag_status)
        THEN trim(p_resolution_note) ELSE NULL END,
      resolved_by = CASE WHEN p_new_status IN ('resolved'::public.risk_flag_status, 'dismissed'::public.risk_flag_status)
        THEN auth.uid() ELSE NULL END,
      resolved_at = CASE WHEN p_new_status IN ('resolved'::public.risk_flag_status, 'dismissed'::public.risk_flag_status)
        THEN now() ELSE NULL END
  WHERE id = v_flag.id;

  INSERT INTO public.risk_flag_events (
    risk_flag_id, actor_id, event_type, previous_status, new_status, event_note
  ) VALUES (
    v_flag.id, auth.uid(), v_action, v_flag.status, p_new_status,
    left(v_note, 2000)
  );

  INSERT INTO public.security_audit_events (
    actor_id, action_key, entity_type, entity_id, summary, metadata
  ) VALUES (
    auth.uid(), 'risk_flag.updated', 'risk_flag', v_flag.id,
    'Updated internal risk review flag status and/or assignment.',
    jsonb_build_object('previous_status', v_flag.status, 'new_status', p_new_status,
      'previous_assignee', v_flag.assigned_to, 'new_assignee', v_new_assignee)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_update_risk_flag(UUID, public.risk_flag_status, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_risk_flag(UUID, public.risk_flag_status, UUID, TEXT) TO authenticated;

-- 11. ROW LEVEL SECURITY AND LEAST-PRIVILEGE GRANTS
ALTER TABLE public.claim_workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_review_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_flag_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workflow templates: admin read" ON public.claim_workflow_templates;
DROP POLICY IF EXISTS "Workflow templates: admin insert" ON public.claim_workflow_templates;
DROP POLICY IF EXISTS "Workflow templates: admin update" ON public.claim_workflow_templates;
DROP POLICY IF EXISTS "Workflow steps: admin read" ON public.claim_workflow_steps;
DROP POLICY IF EXISTS "Workflow steps: admin insert" ON public.claim_workflow_steps;
DROP POLICY IF EXISTS "Workflow steps: admin update" ON public.claim_workflow_steps;
DROP POLICY IF EXISTS "Workflow runs: permitted read" ON public.claim_workflow_runs;
DROP POLICY IF EXISTS "Workflow events: permitted read" ON public.claim_workflow_events;
DROP POLICY IF EXISTS "Risk flags: admin read" ON public.risk_review_flags;
DROP POLICY IF EXISTS "Risk flag events: admin read" ON public.risk_flag_events;
DROP POLICY IF EXISTS "Security audit: admin read" ON public.security_audit_events;

CREATE POLICY "Workflow templates: admin read"
ON public.claim_workflow_templates FOR SELECT TO authenticated
USING (public.is_admin());
CREATE POLICY "Workflow templates: admin insert"
ON public.claim_workflow_templates FOR INSERT TO authenticated
WITH CHECK (public.is_admin() AND (created_by IS NULL OR created_by = (SELECT auth.uid())));
CREATE POLICY "Workflow templates: admin update"
ON public.claim_workflow_templates FOR UPDATE TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Workflow steps: admin read"
ON public.claim_workflow_steps FOR SELECT TO authenticated
USING (public.is_admin());
CREATE POLICY "Workflow steps: admin insert"
ON public.claim_workflow_steps FOR INSERT TO authenticated
WITH CHECK (public.is_admin());
CREATE POLICY "Workflow steps: admin update"
ON public.claim_workflow_steps FOR UPDATE TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Workflow runs: permitted read"
ON public.claim_workflow_runs FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR EXISTS (
    SELECT 1 FROM public.claims c
    WHERE c.id = claim_workflow_runs.claim_id
      AND (c.user_id = (SELECT auth.uid()) OR c.assigned_to = (SELECT auth.uid()))
  )
);
CREATE POLICY "Workflow events: permitted read"
ON public.claim_workflow_events FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    customer_visible = TRUE
    AND EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.id = claim_workflow_events.claim_id AND c.user_id = (SELECT auth.uid())
    )
  )
  OR (
    public.has_app_role('investigator'::public.app_role)
    AND EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.id = claim_workflow_events.claim_id AND c.assigned_to = (SELECT auth.uid())
    )
  )
);

CREATE POLICY "Risk flags: admin read"
ON public.risk_review_flags FOR SELECT TO authenticated
USING (public.is_admin());
CREATE POLICY "Risk flag events: admin read"
ON public.risk_flag_events FOR SELECT TO authenticated
USING (public.is_admin());
CREATE POLICY "Security audit: admin read"
ON public.security_audit_events FOR SELECT TO authenticated
USING (public.is_admin());

REVOKE ALL ON TABLE public.claim_workflow_templates FROM anon, authenticated;
REVOKE ALL ON TABLE public.claim_workflow_steps FROM anon, authenticated;
REVOKE ALL ON TABLE public.claim_workflow_runs FROM anon, authenticated;
REVOKE ALL ON TABLE public.claim_workflow_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.risk_review_flags FROM anon, authenticated;
REVOKE ALL ON TABLE public.risk_flag_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.security_audit_events FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.claim_workflow_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.claim_workflow_steps TO authenticated;
GRANT SELECT ON TABLE public.claim_workflow_runs TO authenticated;
GRANT SELECT ON TABLE public.claim_workflow_events TO authenticated;
GRANT SELECT ON TABLE public.risk_review_flags TO authenticated;
GRANT SELECT ON TABLE public.risk_flag_events TO authenticated;
GRANT SELECT ON TABLE public.security_audit_events TO authenticated;

COMMIT;

-- Remaining operational controls (MFA enforcement, provider alerts, backup policy,
-- production monitoring and incident response) must also be configured in Supabase
-- project settings / deployment operations; this migration does not configure them.
