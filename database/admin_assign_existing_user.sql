-- Grant the application administrator role to ONE trusted existing account.
-- Run only from the Supabase SQL Editor while signed in as a project owner/admin.
-- Replace the email below with the exact email of your own trusted administrator account.
-- Do not put this SQL in frontend code. Do not run it for a customer account.

DO $block$
DECLARE
  v_email TEXT := lower(trim('REPLACE_WITH_YOUR_EMAIL@example.com'));
  v_user_id UUID;
BEGIN
  IF v_email = '' OR v_email = 'replace_with_your_email@example.com' THEN
    RAISE EXCEPTION 'Replace the email placeholder with the exact trusted administrator email before running this script.';
  END IF;

  SELECT u.id INTO v_user_id
  FROM auth.users AS u
  WHERE lower(u.email) = v_email;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No Supabase Auth user exists for this email. Register the account first and check the email address.';
  END IF;

  INSERT INTO public.user_roles (user_id, role, assigned_by)
  VALUES (v_user_id, 'admin'::public.app_role, NULL)
  ON CONFLICT (user_id, role) DO NOTHING;
END;
$block$ LANGUAGE plpgsql;

-- Verify the role assignment. This should return one admin row for the intended account.
SELECT u.email, ur.role, ur.assigned_at
FROM auth.users AS u
JOIN public.user_roles AS ur ON ur.user_id = u.id
WHERE lower(u.email) = lower('REPLACE_WITH_YOUR_EMAIL@example.com')
  AND ur.role IN ('admin'::public.app_role, 'super_admin'::public.app_role);
