REFUND CUSTOMER RECOVERY & PAYOUTS PAGE
======================================

Files in this update
--------------------
customer/recovery.html       Customer recovery balances and payout requests
customer/dashboard.html      Small update adding a live Recovery & Payouts link
customer/claims.html         Adds Recovery & Payouts to customer navigation
css/recovery.css             Styling and responsive layouts
js/customer-recovery.js      Supabase queries and payout request handling

Installation
------------
1. Extract this ZIP over your existing refund-homepage project, preserving the
   folder structure, and allow these listed files to be replaced.
2. Do NOT replace js/config.js. It contains your local Supabase project URL and
   publishable key. This ZIP deliberately does not include that file.
3. Keep your existing js/supabase-client.js. These pages use the established
   window.refundSupabase client and window.refundSupabaseReady flag.
4. Start Live Server from index.html and sign in.
5. Open Customer Dashboard -> Recovery & payouts, or go directly to
   customer/recovery.html using your actual Live Server port.

Prerequisites
-------------
- Migrations 001, 002, and 003 have been applied successfully.
- js/config.js has the correct Supabase URL and publishable key.
- js/supabase-client.js initializes window.refundSupabase.
- Supabase Auth session is active.

What this page does
-------------------
- Reads the current user's own claim recovery balances from
  public.claim_recovery_balances.
- Displays totals grouped by currency (currencies are never added together).
- Displays per-case targets, verified recovered amounts, outstanding amounts,
  and progress.
- Reads the current user's payout request history without displaying stored
  payout destination details.
- Calls public.request_claim_payout only when the UI reports eligibility.
- The database function remains the authoritative enforcement layer for
  ownership, identity verification, account status, full recovery, and payout
  destination requirements. Hiding a UI button is not the security boundary.

Important
---------
- A payout request is not a transfer. Actual bank/crypto transfers are not
  automated by this module.
- A payout request requires a verified identity profile and active account.
  Identity verification workflow/upload UI is not included here.
- Do not collect real customers' payout details until the environment, privacy
  notices, access policies, and operational handling have been reviewed.
- This update does not modify the loan module or overhaul the customer dashboard.
