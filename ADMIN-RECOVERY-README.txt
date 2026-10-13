REFUND — ADMIN RECOVERY LEDGER WORKSPACE
========================================

Prerequisites
-------------
- Supabase project Refund is configured in js/config.js.
- js/supabase-client.js exists and initializes window.refundSupabase (as used by the working login page).
- Migrations 001_core_schema.sql, 002_claims_investigation.sql, and 003_recovery_ledger.sql have succeeded.
- Your trusted account has the admin or super_admin role in public.user_roles.

Install
-------
Merge these files into your existing project, preserving the paths:
  admin/recovery.html
  admin/claims.html (updated to add a Recovery ledger navigation link)
  css/admin-recovery.css
  js/admin-recovery.js

Do not replace js/config.js or any database migration you have already applied.

Open the workspace
------------------
Start Live Server from index.html. While signed in as an administrator, open:
  http://127.0.0.1:5500/admin/recovery.html
Use the port shown by Live Server if it is different.

Features
--------
- View claims and their target/recovered/outstanding balances.
- Configure a recovery target via public.configure_claim_recovery().
- Record a verified installment via public.record_recovery_installment().
- Review payout requests and call public.admin_update_payout_status().
- Sensitive destination values are masked initially and must be deliberately revealed.
- The page checks the signed-in session and admin role; database RLS and RPCs remain the authority.

Important
---------
This is an admin recordkeeping interface. It does not initiate bank transfers or crypto transactions.
Only record installments once receipt is independently verified. Only mark a payout as paid after the real transfer has been confirmed and a transaction reference recorded.
The target-configuration RPC currently does not enforce a claim eligibility status; staff should confirm eligibility before setting a target. Before production launch, align this rule with the business's final approval policy and enforce it server-side.

If data fails to load, inspect the browser developer console and the displayed error. Do not paste Supabase secret keys or customer payout destination details into chat.
