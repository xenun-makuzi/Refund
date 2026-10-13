REFUND ADMIN CONTROL CENTER — INSTALLATION
==========================================

This update adds a central administrator dashboard with shortcuts to all current admin workspaces and live summary counts for priority queues.

FILES IN THIS UPDATE
--------------------
admin/dashboard.html        Central admin control center
css/admin-dashboard.css     Responsive styles
js/admin-dashboard.js       Supabase queries, admin gate, queue counts and recent claims
js/login.js                 Updated login routing for staff/admin roles
admin/education.html        Education article admin workspace
education.html              Public education resource library
education-article.html      Public article page
css/admin-education.css     Education admin styling
css/education.css           Public education styling
js/admin-education.js       Education editor logic
js/education.js             Public resource library logic
js/education-article.js     Public article logic
database/008_education_center.sql  Education schema migration (run only if not already installed)

INSTALLATION
------------
1. Extract this ZIP into the ROOT of the existing refund-homepage project and merge folders.
2. Preserve your current js/config.js and js/supabase-client.js. They are not replaced by this package.
3. The login.js file is updated to route admin/super_admin users to admin/dashboard.html, investigators to admin/claims.html, and support agents to admin/support.html. If you have custom login logic, compare the changes before replacing.
4. Open index.html with Live Server, then sign in. Administrators should be taken to the control center. You can also open admin/dashboard.html directly.
5. Do not rerun migrations 001-007. This ZIP includes migration 008 only for reference. Run database/008_education_center.sql only if you have NOT already installed the education center migration.
6. Identity verification counts and admin page require migration 009 to be installed. If that migration has not run, the dashboard will show the module as unavailable; it will not invent a count.

ADMIN DASHBOARD MODULE LINKS
----------------------------
- Claims & investigations: admin/claims.html
- Recovery ledger & payouts: admin/recovery.html
- Loans & withdrawals: admin/loans.html
- Identity verification: admin/identity-verification.html
- Customer messages: admin/messages.html
- Notifications: admin/notifications.html
- Support & complaints: admin/support.html
- Workflow builder: admin/workflows.html
- Risk review: admin/risk-review.html
- Education center: admin/education.html

SECURITY NOTES
--------------
- The dashboard checks the authenticated user's server-stored role before querying admin summaries.
- It uses the existing Supabase Row Level Security policies; UI checks are not a replacement for database authorization.
- Summary counts fail gracefully if a module table is absent or denied by RLS. Review the module check list for hints.
- Never put a service-role key or secret API key in frontend JavaScript.
- The dashboard reports counts and recent claims only; it does not edit financial amounts or perform payouts.

TESTING CHECKLIST
-----------------
1. Sign in as the trusted admin account; verify it routes to admin/dashboard.html.
2. Check that the priority counts load for claims, identity submissions, payout requests, loan applications, loan withdrawals, support tickets and risk flags.
3. Check recent claims display.
4. Open each module link and confirm its page loads for the correct role.
5. Sign in as a regular customer and try to open admin/dashboard.html directly; no admin data should load.
6. If Education Center migration 008 or identity migration 009 is not installed, verify the page shows a setup warning rather than making up data.

The UI was syntax-checked locally but not tested against your live Supabase project. Verify using test records before public launch.
