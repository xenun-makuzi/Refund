REFUND PLATFORM - SECURE MESSAGING & IN-APP NOTIFICATIONS

This package adds claim-linked customer/staff messaging and an in-app notification center.
It requires the existing Refund Supabase project with migrations 001 through 004 applied.

INSTALL ORDER
1. Back up or commit your current project.
2. Supabase Dashboard > Refund > SQL Editor > New query.
3. Paste the COMPLETE contents of database/005_secure_messaging_notifications.sql and run it once.
4. Merge the supplied customer/, admin/, css/, and js/ files into the existing refund-homepage folder.
5. Merge/replace the included existing HTML navigation files as appropriate. They add links for Messages and Notifications while keeping the existing dashboard design.
6. Keep js/config.js and js/supabase-client.js unchanged. This package deliberately does not include either file.
7. Start Live Server from index.html and sign in.

PAGES
- customer/messages.html: claim-linked customer conversation view.
- admin/messages.html: authorized staff view of conversations for accessible cases.
- customer/notifications.html: customer's in-app notification list.
- admin/notifications.html: staff member's own notifications.

DATABASE SECURITY
- Message inserts are permitted only through public.send_claim_message(...), which checks the claim owner or authorized staff role server-side.
- Private staff notes remain in public.claim_activity with visibility='internal'; the chat is not a replacement for internal case notes.
- Messages are readable only by the claim owner, admins, support agents, and the investigator assigned to the claim (where applicable).
- Message read receipts are written via public.mark_claim_messages_read(...).
- Notification rows can only be read by their recipient. Read status is changed through protected RPC functions.
- In-app notifications are generated for customer-visible claim activity, loan decisions, loan withdrawal updates, recovery payout status updates, and claim messages.
- This does not send email, SMS, push notifications, or money. Those integrations remain separate work.

TESTING
A. Run migration 005 as one complete script. Do not rerun migrations 001-004.
B. Sign in as a regular customer with a claim and open customer/messages.html.
C. Send a test message. Sign in as an authorized admin/support/assigned investigator and open admin/messages.html.
D. Reply from staff; confirm it appears for the customer and notifications are created in user_notifications.
E. Open customer/notifications.html and mark one notification and all notifications read.
F. Test that a normal customer cannot open another user's claim conversation or mark another user's notification read.

NAVIGATION FILES INCLUDED
The package includes navigation updates for the customer dashboard/claims/recovery/loans pages and the admin claims/recovery/loans pages. If you have made your own later changes to those HTML files, merge only the links/cards instead of blindly overwriting your changes.

NOTES
- The chat is attached to a claim. General-purpose support tickets and complaints are a separate future module.
- Messages are plain text and rendered with textContent to avoid HTML injection. No chat attachments are included.
- The staff UI checks user_roles for staff roles, but database RLS and the send-message RPC are the actual security enforcement.
- Test with non-sensitive development data before using real customer data.
