REFUND PLATFORM — WORKFLOW BUILDER + RISK REVIEW (MIGRATION 007)

CONTENTS
- database/007_risk_review_workflows.sql
- admin/workflows.html
- admin/risk-review.html
- css/admin-control-center.css
- js/workflows-admin.js
- js/risk-review-admin.js
- admin/WORKFLOW-RISK-NAV-SNIPPET.txt

BEFORE YOU START
This migration assumes migrations 001–006 have already succeeded in the same Supabase project. Make a database backup before applying any new migration to a production project. Test in a non-production project first where possible.

INSTALL
1. In Supabase, select the Refund project and open SQL Editor > New query.
2. Open database/007_risk_review_workflows.sql in VS Code.
3. Copy the entire file into a blank query. Do not run only a highlighted selection.
4. Run once. If it fails, stop and inspect the exact line/error before retrying. Do not drop existing tables.
5. Extract/merge the new package files into the root of the existing VS Code project, preserving folders.
6. Do not overwrite js/config.js or js/supabase-client.js. They contain your current Supabase configuration and working client initialization.
7. Run index.html through Live Server, sign in with a trusted admin account, then open:
   /admin/workflows.html
   /admin/risk-review.html

WORKFLOW BUILDER
- Create a draft template. Slugs must be lowercase with hyphens, e.g. scam-recovery-review.
- Add stages in the intended order. Step keys use lowercase letters/numbers/underscores, e.g. evidence_review.
- Mark the intended final stage as final. Adding a later stage to a draft will automatically clear the existing final-stage marker first.
- Activate only when the template has one final stage at the last position. The database validates this on activation.
- Assign only active workflows that match a claim's category/source. Version 1 supports one workflow run per claim; an already-assigned claim cannot receive a second run in this interface.
- Advance by one stage at a time. Customer-visible stages create a customer claim timeline item and in-app notification. Internal stages create an internal-only activity item.
- Workflow stage tracking is additional to the existing high-level claim.status field; the module intentionally does not automatically change that status.

RISK REVIEW
- Risk flags are internal markers for human review, not findings or accusations of fraud.
- Only administrators can view or manage the risk review queue.
- Each flag targets exactly one claim, customer account, or loan application.
- Resolving/dismissing a flag requires a resolution note. Assignment accepts active investigator/admin accounts.
- Do not enter passwords, full identity document numbers, full bank/card credentials, or crypto private keys in internal notes.
- The first release creates manual flags only. It does not automatically detect fraud or make eligibility decisions.

SECURITY/AUDIT NOTES
- The database uses RLS, least-privilege table grants, and security-definer RPCs with explicit authorization checks for protected operations.
- security_audit_events records workflow assignments/advances and risk-flag changes in this module. It is not a full login, network, storage-access, or application-error monitoring system.
- MFA enforcement, backups, provider alerts, retention policies, production monitoring, and incident-response procedures still need to be configured and tested in Supabase/deployment settings.
- Keep the Supabase service-role/secret key out of frontend code. Only the project URL and publishable key belong in the public client configuration.

OPTIONAL ADMIN SIDEBAR LINKS
Add these anchors to the existing admin sidebar if you want quick navigation (do not replace your existing working admin files merely to add links):
<a href="workflows.html">Workflow builder</a>
<a href="risk-review.html">Risk review</a>

TEST CHECKLIST
1. Sign in as admin: both pages load and show the admin email.
2. As admin, create a workflow draft and add at least two stages; mark only the last stage final.
3. Activate the workflow and assign it to a test claim that matches the selected category/source.
4. Advance one stage. Confirm the action appears in claim activity and in-app notifications only when the stage is customer-visible.
5. Create a manual risk flag on a test claim/customer/loan; assign it and move it to under review, then resolve with a note.
6. Confirm a normal customer cannot read risk_review_flags, risk_flag_events, or security_audit_events through the client API.
