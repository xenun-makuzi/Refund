REFUND PARTNER REFERRAL CLAIM WORKFLOW — MIGRATION 010

This module implements pre-created company-referred claims and secure account linking.

INSTALL
1. Back up the Supabase database and confirm migrations 001 and 002 are installed.
2. Open Supabase > SQL Editor > New query and run the entire database/010_partner_referral_claims.sql file once.
3. Merge this package into the root of the existing refund-homepage project.
   Included files replace/add:
   - admin/partner-referrals.html (new admin workspace)
   - admin/dashboard.html (adds the Partner referrals navigation link)
   - css/partner-referrals.css (new styles)
   - js/partner-referrals.js (new admin workspace logic)
   - js/dashboard.js (calls the secure claim-linking RPC before loading customer claims)
   - js/register.js (requires the partner referral code for partner-referral registration)
4. Keep js/config.js and js/supabase-client.js unchanged.
5. Run Live Server, sign in as an admin, and open admin/partner-referrals.html.

ADMIN FLOW
- Create a partner organization and a unique referral code (4–100 letters/numbers/_/-).
- Create a pre-referred claim and enter the customer's legal name and intended email.
- Share the company's referral code with the intended customer using your approved communication channel.

CUSTOMER FLOW
- Customer registers using their own email and password, selects company/partner referral, enters the company name and referral code.
- Customer confirms the email address and signs in.
- Customer dashboard calls claim_partner_referrals_for_current_user(). The database only links claims if the Auth email is confirmed and exactly matches the invited email, and the verified partner matches the claim's partner.
- The linked claim appears in the customer's claim list and dashboard. Partner-referred customers should not submit a duplicate generic claim.

IMPORTANT
- Customers do not log in using the company's name. They use their own email/password.
- The partner code identifies the company; it does not by itself grant access to a claim.
- The claim remains unassigned until the customer's email is confirmed and the exact email+partner match passes server-side.
- Admin RPCs check admin privileges server-side. Never put a service-role key in frontend code.
- Test with dummy accounts and claims before using real customer records. Confirm RLS and email-confirmation settings in the actual Supabase project.
