REFUND — FRAUD AWARENESS & EDUCATION CENTER
==========================================

WHAT THIS ADDS
- Public resource library at education.html
- Article detail page at education-article.html?slug=...
- Administrator article editor at admin/education.html
- Migration 008: education_articles, row-level security, publication timestamps, and admin audit metadata
- Six starter awareness guides inserted as published articles (idempotent seed by slug)
- Navigation snippets for homepage, customer dashboard, and admin workspaces

BEFORE INSTALLING
- Back up/export the current database schema or confirm you can restore your project.
- Migrations 001 through 007 should already be applied.
- Keep your existing js/config.js and js/supabase-client.js. Do not overwrite them with any file from a starter package.

DATABASE SETUP
1. Open Supabase Dashboard > Refund > SQL Editor > New query.
2. Open database/008_education_center.sql from this package and copy the COMPLETE file.
3. Paste into the new query and run once.
4. Expected: education_articles table exists and six starter guides are present with status 'published'.
5. If an error occurs, stop and share the exact error text and line number. Do not repeatedly rerun the query without checking the error.

FRONTEND INSTALLATION
Merge the package folders into your existing project root, preserving paths:
- education.html
- education-article.html
- admin/education.html
- css/education.css
- css/admin-education.css
- js/education.js
- js/education-article.js
- js/admin-education.js

Do NOT replace js/config.js, js/supabase-client.js, login.js, or other existing working files.

NAVIGATION
The package does not replace index.html or existing dashboard/admin files to avoid overwriting local customizations.
Use EDUCATION-NAV-SNIPPETS.txt to add a Resource Center link to the homepage and workspaces. Pages also work via direct URL.

TESTS
1. Open education.html through Live Server while signed out. Published articles should load publicly.
2. Open an article card. The article page should render the title and plain-text/limited-Markdown content.
3. Sign in as a trusted admin and open admin/education.html.
4. Create a draft of at least 80 characters, save, and ensure it is not visible publicly.
5. Publish it and open its public article link in a private/incognito window.
6. Archive it and verify it is no longer listed publicly.
7. Check public security_audit_events from the admin audit UI if available; the trigger records article metadata only, never article body contents.

SECURITY AND CONTENT NOTES
- Public visitors can SELECT published articles only. Drafts and archived entries are hidden by row-level security.
- Writing and publishing require the pre-existing public.is_admin() function to recognize an authenticated admin/super_admin role.
- The editor accepts plain text / limited Markdown only. The public renderer uses DOM textContent; it does not execute stored HTML.
- Articles are general awareness information, not jurisdiction-specific legal, tax, or financial advice.
- Starter guides avoid claiming government affiliation and warn that recovery is not guaranteed.
- The module does not implement a public article comments feature or analytics.
- No secret/service-role key belongs in browser code.
