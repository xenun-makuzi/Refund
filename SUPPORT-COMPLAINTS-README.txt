REFUND PLATFORM — SUPPORT & COMPLAINTS MODULE (MIGRATION 006)

WHAT'S INCLUDED
- database/006_support_complaints.sql: support tickets, customer/staff replies, internal notes, ticket events, notifications integration, RLS and server-side RPCs.
- customer/support.html: customer support request flow, list/detail, replies, escalation request.
- admin/support.html: staff queue, assignment, priority/status management, customer replies and internal notes.
- css/support.css: support workspace styling, using the existing communications.css foundation.
- js/support-tickets.js: customer/staff interactions via Supabase.
- js/notifications.js: updated so support notification cards can open their related ticket.
- updated customer/admin navigation and customer dashboard support card.

INSTALLATION
1. Make a backup / commit your current project before merging these files.
2. In Supabase > SQL Editor > New query, paste the ENTIRE contents of database/006_support_complaints.sql and run it once. It requires migrations 001–005.
3. Extract the package and merge folders into your existing refund-homepage project, replacing only included files.
4. Keep js/config.js and js/supabase-client.js unchanged.
5. Run index.html with Live Server; customer support is at customer/support.html and staff support is at admin/support.html.
6. Sign in as a customer, open Help & complaints, create a test ticket, reply, and try escalation while the ticket is open.
7. Sign in with an admin or support_agent account; open admin/support.html; inspect the ticket, add a customer-visible reply, add an internal note, change status, and verify notifications.

PERMISSIONS / BEHAVIOR
- Customer tickets are created and replied to only through protected RPC functions.
- Customers can only link a claim they own.
- Customer queries are restricted by RLS to their own tickets and customer-visible messages/events.
- Internal staff notes are visible only to permitted staff, not the ticket owner.
- Staff assignment is validated against the staff role table; investigators are restricted to tickets assigned to them for read/reply/status updates.
- Closing/resolving a ticket requires a customer-visible note.
- Customer escalation is recorded in the ticket event history and notifies staff.
- Support notices are in-app only. No email/SMS delivery provider is configured.
- No real financial transaction is made by this module.

IMPORTANT
- The SQL and frontend have not been executed against the user's live Supabase project in this environment. Run the migration and test both customer and staff roles in a non-production/test account first.
- Do not expose database passwords, service-role keys, or secret keys in frontend JavaScript.
- Before production, review the schema and RPCs with your deployment/compliance requirements, configure retention/backups, and test RLS with separate customer and staff test accounts.
