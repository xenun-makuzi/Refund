-- ============================================================
-- REFUND PLATFORM - IDENTITY VERIFICATION
-- Migration 009. Requires migrations 001, 005, 006, and 007.
-- This migration does not require the optional education migration 008.
-- Run the complete file once in a NEW Supabase SQL Editor query.
-- ============================================================

BEGIN;

-- 1. PRIVATE SUBMISSION METADATA. Identity files remain in a private Storage bucket.
CREATE TABLE IF NOT EXISTS public.identity_verification_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'passport', 'national_id', 'drivers_license', 'residence_permit', 'other'
  )),
  document_front_path TEXT NOT NULL,
  document_back_path TEXT,
  status public.identity_verification_status NOT NULL DEFAULT 'pending',
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT identity_submission_status_allowed CHECK (
    status IN (
      'pending'::public.identity_verification_status,
      'verified'::public.identity_verification_status,
      'rejected'::public.identity_verification_status,
      'action_required'::public.identity_verification_status
    )
  ),
  CONSTRAINT identity_front_path_owned_folder CHECK (
    document_front_path LIKE user_id::text || '/%'
  ),
  CONSTRAINT identity_back_path_owned_folder CHECK (
    document_back_path IS NULL OR document_back_path LIKE user_id::text || '/%'
  )
);

CREATE INDEX IF NOT EXISTS identity_submissions_user_created_idx
  ON public.identity_verification_submissions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS identity_submissions_status_created_idx
  ON public.identity_verification_submissions (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS identity_submissions_one_pending_per_user_uidx
  ON public.identity_verification_submissions (user_id)
  WHERE status = 'pending'::public.identity_verification_status;

-- 2. PRIVATE STORAGE BUCKET. Images and PDFs only, maximum 10 MiB per file.
INSERT INTO storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
VALUES (
  'identity-documents',
  'identity-documents',
  FALSE,
  10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = FALSE,
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']::text[];

-- Validate that files exist in the private bucket before a submission can be created.
-- The Storage bucket separately enforces accepted MIME types and a 10 MiB size limit.
CREATE OR REPLACE FUNCTION public.validate_identity_document_paths()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'You can only submit identity documents for your own account.' USING ERRCODE = '42501';
  END IF;

  IF NEW.status <> 'pending'::public.identity_verification_status THEN
    RAISE EXCEPTION 'New identity submissions must start in pending status.' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM storage.objects AS o
    WHERE o.bucket_id = 'identity-documents'
      AND o.name = NEW.document_front_path
  ) THEN
    RAISE EXCEPTION 'The main identity document must be uploaded before submission.' USING ERRCODE = '22023';
  END IF;

  IF NEW.document_back_path IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM storage.objects AS o
    WHERE o.bucket_id = 'identity-documents'
      AND o.name = NEW.document_back_path
  ) THEN
    RAISE EXCEPTION 'The back-side document must be uploaded before submission.' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.validate_identity_document_paths() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS identity_submission_validate_paths
  ON public.identity_verification_submissions;
CREATE TRIGGER identity_submission_validate_paths
BEFORE INSERT ON public.identity_verification_submissions
FOR EACH ROW
EXECUTE FUNCTION public.validate_identity_document_paths();

-- 3. SYNC PROFILE STATUS AFTER SUBMISSION OR ADMIN REVIEW.
-- This runs with a controlled definer context because customers cannot update profiles.
CREATE OR REPLACE FUNCTION public.sync_identity_status_to_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  UPDATE public.profiles
  SET identity_status = NEW.status,
      updated_at = now()
  WHERE id = NEW.user_id;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.sync_identity_status_to_profile() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS identity_submission_sync_profile_status
  ON public.identity_verification_submissions;
CREATE TRIGGER identity_submission_sync_profile_status
AFTER INSERT OR UPDATE OF status
ON public.identity_verification_submissions
FOR EACH ROW
EXECUTE FUNCTION public.sync_identity_status_to_profile();

-- 4. ROW LEVEL SECURITY AND LEAST-PRIVILEGE TABLE GRANTS.
ALTER TABLE public.identity_verification_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Identity submissions: customer read own"
  ON public.identity_verification_submissions;
DROP POLICY IF EXISTS "Identity submissions: admins read all"
  ON public.identity_verification_submissions;
DROP POLICY IF EXISTS "Identity submissions: customer submit own pending"
  ON public.identity_verification_submissions;

CREATE POLICY "Identity submissions: customer read own"
ON public.identity_verification_submissions
FOR SELECT
TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Identity submissions: admins read all"
ON public.identity_verification_submissions
FOR SELECT
TO authenticated
USING (public.is_admin());

CREATE POLICY "Identity submissions: customer submit own pending"
ON public.identity_verification_submissions
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND status = 'pending'::public.identity_verification_status
  AND document_front_path LIKE (SELECT auth.uid())::text || '/%'
  AND (
    document_back_path IS NULL
    OR document_back_path LIKE (SELECT auth.uid())::text || '/%'
  )
  AND EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = (SELECT auth.uid())
      AND p.account_status = 'active'::public.account_status
      AND p.identity_status IN (
        'unsubmitted'::public.identity_verification_status,
        'rejected'::public.identity_verification_status,
        'action_required'::public.identity_verification_status
      )
  )
);

REVOKE ALL ON TABLE public.identity_verification_submissions FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.identity_verification_submissions TO authenticated;

-- 5. PRIVATE STORAGE POLICIES. No public access. Admin previews use short-lived signed URLs.
DROP POLICY IF EXISTS "Identity documents: upload to own folder"
  ON storage.objects;
DROP POLICY IF EXISTS "Identity documents: owner or admin read"
  ON storage.objects;
DROP POLICY IF EXISTS "Identity documents: delete own unattached uploads"
  ON storage.objects;

CREATE POLICY "Identity documents: upload to own folder"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'identity-documents'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  AND EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.id = (SELECT auth.uid())
      AND p.account_status = 'active'::public.account_status
      AND p.identity_status IN (
        'unsubmitted'::public.identity_verification_status,
        'rejected'::public.identity_verification_status,
        'action_required'::public.identity_verification_status
      )
  )
);

CREATE POLICY "Identity documents: owner or admin read"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'identity-documents'
  AND (
    (storage.foldername(name))[1] = (SELECT auth.uid())::text
    OR public.is_admin()
  )
);

CREATE POLICY "Identity documents: delete own unattached uploads"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'identity-documents'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  AND NOT EXISTS (
    SELECT 1
    FROM public.identity_verification_submissions AS s
    WHERE s.document_front_path = storage.objects.name
       OR s.document_back_path = storage.objects.name
  )
);

-- 6. ALLOW IDENTITY REVIEW UPDATES IN THE EXISTING IN-APP NOTIFICATION TABLE.
ALTER TABLE public.user_notifications
  DROP CONSTRAINT IF EXISTS user_notifications_notification_type_check;
ALTER TABLE public.user_notifications
  ADD CONSTRAINT user_notifications_notification_type_check CHECK (notification_type IN (
    'claim_message', 'claim_update', 'loan_update', 'loan_withdrawal_update',
    'recovery_payout_update', 'support_ticket_created', 'support_ticket_message',
    'support_ticket_update', 'identity_verification_update'
  ));

-- 7. ADMIN-ONLY RPC TO LIST SUBMISSIONS, INCLUDING THE AUTH EMAIL.
-- The RPC returns document paths only to authenticated administrators.
CREATE OR REPLACE FUNCTION public.admin_list_identity_submissions(
  p_status TEXT DEFAULT 'pending'
)
RETURNS TABLE (
  submission_id UUID,
  user_id UUID,
  user_email TEXT,
  full_name TEXT,
  document_type TEXT,
  document_front_path TEXT,
  document_back_path TEXT,
  status public.identity_verification_status,
  review_note TEXT,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can view the identity review queue.' USING ERRCODE = '42501';
  END IF;

  IF p_status IS NULL OR p_status NOT IN ('pending', 'verified', 'rejected', 'action_required', 'all') THEN
    RAISE EXCEPTION 'Invalid identity status filter.' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.user_id,
    u.email::text,
    COALESCE(p.full_name, 'Customer')::text,
    s.document_type,
    s.document_front_path,
    s.document_back_path,
    s.status,
    s.review_note,
    s.created_at,
    s.reviewed_at
  FROM public.identity_verification_submissions AS s
  JOIN auth.users AS u ON u.id = s.user_id
  LEFT JOIN public.profiles AS p ON p.id = s.user_id
  WHERE p_status = 'all' OR s.status::text = p_status
  ORDER BY
    CASE WHEN s.status = 'pending'::public.identity_verification_status THEN 0 ELSE 1 END,
    s.created_at DESC
  LIMIT 500;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_list_identity_submissions(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_identity_submissions(TEXT) TO authenticated;

-- 8. ADMIN REVIEW RPC. Approval/rejection cannot be performed by direct browser writes.
CREATE OR REPLACE FUNCTION public.review_identity_submission(
  p_submission_id UUID,
  p_status public.identity_verification_status,
  p_review_note TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id UUID;
  v_document_type TEXT;
  v_title TEXT;
  v_body TEXT;
  v_note TEXT := NULLIF(left(trim(COALESCE(p_review_note, '')), 2000), '');
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can decide identity verification.' USING ERRCODE = '42501';
  END IF;

  IF p_status IS NULL OR p_status NOT IN (
    'verified'::public.identity_verification_status,
    'rejected'::public.identity_verification_status,
    'action_required'::public.identity_verification_status
  ) THEN
    RAISE EXCEPTION 'Choose verified, rejected, or action_required as the review decision.' USING ERRCODE = '22023';
  END IF;

  IF p_status IN (
    'rejected'::public.identity_verification_status,
    'action_required'::public.identity_verification_status
  ) AND COALESCE(char_length(trim(v_note)), 0) < 5 THEN
    RAISE EXCEPTION 'Provide a clear reason or next step for this decision.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.identity_verification_submissions AS s
  SET status = p_status,
      review_note = v_note,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  WHERE s.id = p_submission_id
    AND s.status = 'pending'::public.identity_verification_status
  RETURNING s.user_id, s.document_type
  INTO v_user_id, v_document_type;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending identity submission not found. Refresh the queue.' USING ERRCODE = 'P0002';
  END IF;

  -- Profile status is synchronized by the table trigger above.
  IF p_status = 'verified'::public.identity_verification_status THEN
    v_title := 'Identity verification approved';
    v_body := 'Your identity document has been reviewed and marked as verified.';
  ELSIF p_status = 'action_required'::public.identity_verification_status THEN
    v_title := 'More information needed for identity verification';
    v_body := 'Your identity review needs an update. Sign in and open Identity verification to see the review note and resubmit if needed.';
  ELSE
    v_title := 'Identity verification not approved';
    v_body := 'Your identity submission was not approved. Sign in and open Identity verification to review the next steps.';
  END IF;

  INSERT INTO public.user_notifications (
    recipient_id, notification_type, title, body
  ) VALUES (
    v_user_id, 'identity_verification_update', v_title, left(v_body, 600)
  );

  INSERT INTO public.security_audit_events (
    actor_id, action_key, entity_type, entity_id, summary, metadata
  ) VALUES (
    auth.uid(),
    'identity_verification_reviewed',
    'identity_verification_submission',
    p_submission_id,
    'Identity submission reviewed with status: ' || p_status::text,
    jsonb_build_object(
      'user_id', v_user_id,
      'document_type', v_document_type,
      'status', p_status::text
    )
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.review_identity_submission(UUID, public.identity_verification_status, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_identity_submission(UUID, public.identity_verification_status, TEXT) TO authenticated;

COMMIT;

-- Security notes:
-- * The identity-documents bucket is private.
-- * Customers may only submit their own pending submission; they cannot set verified status.
-- * Only admins can list all users' submissions, create document signed URLs, or decide verification.
-- * The UI permits images/PDF up to 10 MiB; Storage enforces bucket MIME/size restrictions too.
-- * Confirm your applicable privacy/retention rules before using real identity documents.
