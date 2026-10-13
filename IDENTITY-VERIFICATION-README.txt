REFUND PLATFORM — CIRCULAR RECOVERY WIDGETS + IDENTITY VERIFICATION

WHAT'S IN THIS UPDATE
- Updated customer dashboard with circular recovery progress widgets.
- A dashboard verification panel with a status-aware call to action.
- Customer identity submission page (customer/verification.html).
- Private identity document storage and status history.
- Admin identity review queue (admin/identity-verification.html).
- Admin-only review RPC which synchronizes profiles, writes audit events, and creates in-app notifications.
- SQL migration 009_identity_verification.sql.

IMPORTANT CONFIGURATION
1. Back up your current project folder before merging these files.
2. Do not overwrite js/config.js or js/supabase-client.js. Keep the working versions on your computer.
3. Merge the ZIP folders into the root of your existing refund-homepage project.
4. Run the entire database/009_identity_verification.sql migration in a NEW Supabase SQL Editor query.
5. This migration requires the existing core schema (001), messaging/notifications (005), support notification extension (006), and audit table from migration 007. It does not depend on optional education migration 008.
6. Confirm the identity-documents storage bucket is private after the migration runs.
7. Open customer/verification.html as a signed-in customer. Open admin/identity-verification.html as an authorized admin.

CUSTOMER FLOW
- The customer chooses a document type, submits the main side/photo page, and can optionally submit a back side.
- Supported file types: JPG/JPEG, PNG, WebP, and PDF. Each file is limited to 10 MiB.
- Documents use random storage filenames under the user's own UUID folder in the private identity-documents bucket.
- User consent is required before upload. No government ID number is collected by this form.
- A customer can submit when the profile is unsubmitted, rejected, or action_required, and the account is active.
- A pending submission updates profiles.identity_status to pending. Customers cannot set verified status themselves.

ADMIN FLOW
- Only admin/super_admin accounts can use the review queue RPC.
- Admins create short-lived signed URLs to preview private documents (60 seconds).
- Decisions are verified, rejected, or action_required. Rejection/action_required require a clear review note.
- The decision updates the profile status, creates an in-app notification, and writes an audit event.

SECURITY / PRIVACY
- Never make the identity-documents bucket public.
- Never put a service-role/secret key in frontend files.
- This is a starter KYC workflow, not proof of regulatory compliance or an automated identity-document authenticity check.
- Confirm jurisdiction-specific KYC, privacy, retention, deletion, and access-control requirements before collecting real customer documents.
- Review actual data retention and incident-response policies before launch.

TEST CHECKLIST
1. Run migration 009 successfully.
2. As a normal customer, open verification, submit a test ID image/PDF, and confirm status becomes pending.
3. Confirm a second submission is blocked while one is pending.
4. As an admin, open the identity review queue, generate a private document preview link, and choose action_required with a note.
5. As the customer, confirm the status and in-app notification update; submit a replacement only after action_required.
6. As the admin, approve a submission and confirm the profile status becomes verified.
7. Confirm a normal customer cannot see another customer's submission or access another user's storage path.
8. On the customer dashboard, verify circular progress rings reflect actual ledger totals and the identity panel reflects the real profile status.
