REFUND CUSTOMER DASHBOARD UPGRADE
=================================

This update replaces the existing customer dashboard with a responsive dashboard overview connected to the Supabase tables/views already installed through migrations 001-008.

FILES INCLUDED
--------------
customer/dashboard.html
css/customer-dashboard.css
js/dashboard.js

INSTALLATION
------------
1. Make a backup of your existing customer/dashboard.html.
2. Extract this ZIP into the root of your current project folder, merging folders and replacing the included dashboard file.
3. Keep your existing js/config.js and js/supabase-client.js unchanged. They contain your local Supabase configuration and client initializer and are intentionally not included in this package.
4. Confirm these paths exist in your project:
   - customer/dashboard.html
   - css/customer-dashboard.css
   - js/dashboard.js
   - js/config.js
   - js/supabase-client.js
5. Run the project through Live Server and sign in.

WHAT IT CONNECTS TO
-------------------
- profiles: signed-in user's name and verification/account status
- claims: recent claims and exact active-claim count
- claim_recovery_balances: admin-configured recovery target, ledger-reported recovered total, remaining amount and payout eligibility by currency
- loan_applications: recent loan requests and approved-loan count
- payout_requests: recent payout request status
- user_notifications: recent account updates, unread updates, and unread claim-message notification count
- support_tickets: exact active support-ticket count
- user_roles: optional admin workspace link for administrator users

IMPORTANT
---------
- No SQL migration is required for this dashboard update.
- It does not change the recovery ledger or allow client-side balance edits.
- Balances are grouped per currency and loaded from the database; no sample balances are hardcoded.
- Failed data requests show an error state rather than being represented as zero-balance accounts.
- Payout requests are not proof that funds have been transferred. Loan approvals are not proof of disbursement.
- Real behavior depends on the database migrations and RLS policies already installed in your Supabase project.
- This update was checked for JavaScript syntax and local asset paths but has not been executed against your live Supabase project from this environment.

TEST CHECKLIST
--------------
1. Sign in as a normal customer.
2. Confirm the greeting shows the profile name when available.
3. Confirm active claims, recovery accounts, approved loans, and unread updates load from Supabase.
4. Confirm every currency has its own recovery card and the remaining amount equals target less verified recovery, as computed by the database view.
5. Confirm the recent claims, updates, loan requests and payout requests sections load.
6. Confirm the mobile menu opens and closes on a narrow screen.
7. Confirm sign out sends you back to login.
8. If a widget fails, open DevTools Console/Network and share the error message without sharing credentials or keys.
