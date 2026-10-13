(() => {
  "use strict";
  const client = window.refundSupabase;
  const $ = (s) => document.querySelector(s);
  const els = { message: $("#pr-message"), email: $("#pr-user-email"), signout: $("#pr-signout"), partnerForm: $("#partner-form"), claimForm: $("#claim-form"), partnerSelect: $("#claim-partner"), table: $("#pr-intakes"), refresh: $("#pr-refresh") };
  let currentUser = null;
  const categoryLabels = { scam_recovery: "Scam recovery", purchase_refund: "Purchase refund", tax_refund: "Tax refund", service_dispute: "Service dispute", other: "Other" };
  function message(text, error = false) { els.message.hidden = false; els.message.textContent = text; els.message.classList.toggle("is-error", error); }
  function clearMessage() { els.message.hidden = true; els.message.textContent = ""; els.message.classList.remove("is-error"); }
  function safeCell(value) { const td = document.createElement("td"); td.textContent = value ?? "—"; return td; }
  function fmtDate(value) { if (!value) return "—"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(); }
  async function requireAdmin() {
    if (!window.refundSupabaseReady || !client) { message("Supabase is not connected. Check your existing js/config.js and js/supabase-client.js.", true); return false; }
    const { data, error } = await client.auth.getSession();
    if (error || !data?.session) { window.location.href = "../login.html"; return false; }
    currentUser = data.session.user; els.email.textContent = currentUser.email || "Signed in";
    const { data: roles, error: roleError } = await client.from("user_roles").select("role").eq("user_id", currentUser.id);
    if (roleError || !roles?.some((r) => ["admin", "super_admin"].includes(r.role))) { message("Administrator access is required for partner and referral management.", true); return false; }
    return true;
  }
  async function loadPartners() {
    const { data, error } = await client.from("partner_organizations").select("id,name,referral_code,is_active,created_at").eq("is_active", true).order("name");
    if (error) { els.partnerSelect.innerHTML = "<option value=''>Could not load partners</option>"; throw error; }
    els.partnerSelect.replaceChildren(new Option("Choose a partner…", ""));
    for (const p of data || []) { const opt = new Option(`${p.name} · ${p.referral_code}`, p.id); els.partnerSelect.add(opt); }
  }
  async function loadIntakes() {
    els.table.innerHTML = "<tr><td colspan='6'>Loading referral claims…</td></tr>";
    const { data, error } = await client.from("partner_claim_intakes").select("id,claim_id,partner_organization_id,invited_email,invited_name,status,created_at,claims(case_reference,title),partner_organizations(name)").order("created_at", { ascending: false }).limit(100);
    if (error) { els.table.innerHTML = "<tr><td colspan='6'>Could not load referral records. Check migration 010 and table permissions.</td></tr>"; throw error; }
    els.table.replaceChildren();
    if (!data?.length) { els.table.innerHTML = "<tr><td colspan='6'>No pre-created referral claims yet.</td></tr>"; return; }
    for (const item of data) {
      const tr = document.createElement("tr");
      tr.append(safeCell(item.claims?.case_reference || "Pending reference"), safeCell(item.invited_name), safeCell(item.invited_email), safeCell(item.partner_organizations?.name), safeCell(fmtDate(item.created_at)));
      const statusTd = document.createElement("td"); const pill = document.createElement("span"); pill.className = "pr-pill"; pill.textContent = (item.status || "unknown").replaceAll("_", " "); statusTd.append(pill); tr.append(statusTd); els.table.append(tr);
    }
  }
  els.partnerForm.addEventListener("submit", async (event) => {
    event.preventDefault(); clearMessage();
    const button = els.partnerForm.querySelector("button[type=submit]"); button.disabled = true;
    try {
      const name = $("#partner-name").value.trim(); const code = $("#partner-code").value.trim();
      const { error } = await client.rpc("admin_create_partner_organization", { p_name: name, p_referral_code: code });
      if (error) throw error;
      els.partnerForm.reset(); await loadPartners(); message("Partner created. Give the referral code only to the intended partner/customer channel.");
    } catch (error) { console.error("Partner creation failed:", error); message(error.message || "Could not create partner. Check that migration 010 ran and the referral code is unique.", true); }
    finally { button.disabled = false; }
  });
  els.claimForm.addEventListener("submit", async (event) => {
    event.preventDefault(); clearMessage();
    const button = els.claimForm.querySelector("button[type=submit]"); button.disabled = true;
    const amountValue = $("#claim-amount").value.trim();
    try {
      const args = {
        p_partner_id: els.partnerSelect.value,
        p_customer_email: $("#customer-email").value.trim().toLowerCase(),
        p_customer_name: $("#customer-name").value.trim(),
        p_category: $("#claim-category").value,
        p_title: $("#claim-title").value.trim(),
        p_description: $("#claim-description").value.trim(),
        p_merchant_name: $("#merchant-name").value.trim() || null,
        p_transaction_date: $("#transaction-date").value || null,
        p_requested_amount: amountValue === "" ? null : Number(amountValue),
        p_currency: $("#claim-currency").value
      };
      const { data, error } = await client.rpc("admin_create_partner_claim", args);
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      els.claimForm.reset(); await loadIntakes();
      message(`Claim created: ${result?.case_reference || "reference generated"}. It will appear in the customer's account after they register with the matching partner referral and confirm the invited email address.`);
    } catch (error) { console.error("Partner claim creation failed:", error); message(error.message || "Could not create the referred claim. Check required fields and migration 010.", true); }
    finally { button.disabled = false; }
  });
  els.refresh.addEventListener("click", async () => { clearMessage(); try { await loadPartners(); await loadIntakes(); message("Referral data refreshed."); } catch (error) { message(error.message || "Could not refresh referral data.", true); } });
  els.signout.addEventListener("click", async () => { const { error } = await client.auth.signOut(); if (error) { message("Sign out failed. Please try again.", true); return; } window.location.href = "../login.html"; });
  document.addEventListener("DOMContentLoaded", async () => { if (!await requireAdmin()) return; try { await loadPartners(); await loadIntakes(); } catch (error) { console.error("Partner referral page init failed:", error); if (els.message.hidden) message("A referral workspace query failed. Check the migration and RLS permissions.", true); } });
})();
