REFUND PLATFORM — ADMIN INVESTIGATION WORKSPACE

FILES
- admin/claims.html
- css/admin-claims.css
- js/admin-claims.js
- database/admin_assign_existing_user.sql

BEFORE OPENING THE WORKSPACE
1. This workspace expects core migration 001 and claims migration 002 to have completed successfully.
2. Keep your own js/config.js unchanged. It must contain your Supabase project URL and publishable key; do not use a secret/service-role key in frontend JavaScript.
3. Your own account must have the `admin` (or `super_admin`) role. If this was already assigned through a trusted Supabase SQL Editor session, skip step 4.
4. To assign the role, open database/admin_assign_existing_user.sql, replace BOTH occurrences of REPLACE_WITH_YOUR_EMAIL@example.com with the exact email of your own trusted registered account, and run it as a separate query in Supabase SQL Editor. Never put this script in the frontend. Verify the returned admin row.
5. To assign an investigator, a trusted project owner/admin must add the `investigator` role to an appropriate existing user in public.user_roles using Supabase SQL Editor. Only active profiles are shown in the assignment dropdown. Example, after replacing the email:

INSERT INTO public.user_roles (user_id, role, assigned_by)
SELECT u.id, 'investigator'::public.app_role, NULL
FROM auth.users AS u
JOIN public.profiles AS p ON p.id = u.id AND p.account_status = 'active'
WHERE lower(u.email) = lower('REPLACE_WITH_INVESTIGATOR_EMAIL@example.com')
ON CONFLICT (user_id, role) DO NOTHING;

OPEN
- Merge these files into the existing project without overwriting js/config.js.
- Run index.html with Live Server, sign in as the administrator, then open admin/claims.html in the same origin (same host and port).
- URL example: http://127.0.0.1:5500/admin/claims.html (use your actual Live Server port).

WHAT IT DOES
- Lists claims visible to the admin's role and searches/filter by status/category.
- Shows case summary, activity (including internal notes visible to admin), and evidence metadata.
- Creates short-lived signed links for evidence in the private claim-evidence bucket.
- Uses existing database RPC functions assign_claim, update_claim_status, and add_claim_activity for mutations.
- The frontend does not write assignment, claim status, or activity rows directly.

KNOWN SCOPE
- It is an admin workspace for this initial build, not a complete staff management module.
- Creating investigator accounts/roles is intentionally kept in a trusted administrative context, not exposed as a self-service browser action.
- Evidence review status is read-only in this UI; no evidence-review RPC has been created in migration 002.
- Before production use, review all RLS/storage policies, audit behavior, data retention, and operational security.
