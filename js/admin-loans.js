(() => {
  "use strict";
  const client = window.refundSupabase;
  const $ = (selector, root = document) => root.querySelector(selector);
  const el = {
    email: $("#al-admin-email"), role: $("#al-admin-role"), signOut: $("#al-sign-out"), refresh: $("#al-refresh"),
    message: $("#al-global-message"), metricTotal: $("#al-metric-total"), metricPending: $("#al-metric-pending"),
    metricApproved: $("#al-metric-approved"), metricWithdrawals: $("#al-metric-withdrawals"),
    search: $("#al-search"), filter: $("#al-status-filter"), appBody: $("#al-applications-body"),
    appCount: $("#al-app-count"), appEmpty: $("#al-applications-empty"), detail: $("#al-application-detail"),
    detailMessage: $("#al-detail-message"), detailTitle: $("#al-detail-title"), detailReference: $("#al-detail-reference"),
    applicant: $("#al-detail-applicant"), amount: $("#al-detail-amount"), term: $("#al-detail-term"), date: $("#al-detail-date"),
    purpose: $("#al-detail-purpose"), events: $("#al-application-events"), eventCount: $("#al-event-count"),
    reviewForm: $("#al-review-form"), newStatus: $("#al-new-status"), approvedFields: $("#al-approved-fields"),
    approvedAmount: $("#al-approved-amount"), approvedTerm: $("#al-approved-term"), reason: $("#al-decision-reason"),
    reviewButton: $("#al-review-submit"), reviewHelper: $("#al-review-helper"), closeDetail: $("#al-close-detail"),
    withdrawalCount: $("#al-withdrawal-count"), withdrawals: $("#al-withdrawals-list"), withdrawalsEmpty: $("#al-withdrawals-empty")
  };
  const applicationStatuses = {
    submitted: "Submitted", under_review: "Under review",
    additional_information_required: "More information required", approved: "Approved",
    rejected: "Rejected", withdrawn: "Withdrawn"
  };
  const withdrawalStatuses = { requested: "Requested", approved: "Approved", denied: "Denied", processing: "Processing", paid: "Paid", failed: "Failed" };
  let currentUser = null;
  let currentRole = null;
  let applications = [];
  let withdrawals = [];
  let applicationEvents = [];
  let withdrawalEvents = [];
  let profilesById = new Map();
  let selectedApplication = null;
  let destinationRevealed = new Set();
  let busy = false;

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }
  function message(target, text, kind = "info") {
    if (!target) return;
    target.hidden = false;
    target.className = `al-message${kind === "error" ? " is-error" : kind === "warning" ? " is-warning" : ""}`;
    target.textContent = text;
  }
  function clearMessage(target) {
    if (!target) return;
    target.hidden = true; target.textContent = ""; target.className = "al-message";
  }
  function formatMoney(value, currency = "USD") {
    const amount = Number(value); const code = String(currency || "USD").trim().toUpperCase();
    if (!Number.isFinite(amount)) return "—";
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: code, maximumFractionDigits: 2 }).format(amount); }
    catch { return `${code} ${amount.toFixed(2)}`; }
  }
  function formatDate(value, time = false) {
    if (!value) return "—"; const date = new Date(value); if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, time ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(date);
  }
  function titleCase(value) { return String(value || "Unknown").replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
  function statusClass(status) {
    if (["approved", "paid"].includes(status)) return "is-approved";
    if (["rejected", "denied", "failed", "withdrawn"].includes(status)) return "is-rejected";
    if (["under_review", "additional_information_required", "requested", "processing"].includes(status)) return status === "processing" ? "is-processing" : "is-review";
    return "";
  }
  function pill(status, labels) { return node("span", `al-status ${statusClass(status)}`, labels[status] || titleCase(status)); }
  function filteredApplications() {
    const term = el.search.value.trim().toLowerCase(); const status = el.filter.value;
    return applications.filter((app) => {
      if (status !== "all" && app.status !== status) return false;
      const profile = profilesById.get(app.user_id);
      const searchable = [app.application_reference, app.purpose, profile?.full_name, app.currency, app.status].join(" ").toLowerCase();
      return !term || searchable.includes(term);
    });
  }
  function renderApplications() {
    const list = filteredApplications();
    el.appBody.replaceChildren();
    el.appCount.textContent = `${list.length} ${list.length === 1 ? "application" : "applications"}`;
    el.appEmpty.hidden = list.length > 0;
    if (!list.length) {
      const row = node("tr"); const cell = node("td", "al-placeholder", applications.length ? "No applications match these filters." : "No loan applications have been submitted yet."); cell.colSpan = 6; row.append(cell); el.appBody.append(row);
      return;
    }
    for (const app of list) {
      const row = node("tr"); if (selectedApplication?.id === app.id) row.classList.add("is-selected");
      const identCell = node("td"); const ident = node("div", "al-application-ident");
      ident.append(node("strong", "", app.application_reference), node("span", "", profilesById.get(app.user_id)?.full_name || "Customer"), node("small", "", app.purpose.slice(0, 80) + (app.purpose.length > 80 ? "…" : "")));
      identCell.append(ident);
      row.append(identCell, node("td", "", formatMoney(app.requested_amount, app.currency)), node("td", "", app.requested_term_months ? `${app.requested_term_months} months` : "—"));
      const statusCell = node("td"); statusCell.append(pill(app.status, applicationStatuses)); row.append(statusCell);
      row.append(node("td", "", formatDate(app.created_at)));
      const actionCell = node("td"); const button = node("button", "al-row-button", selectedApplication?.id === app.id ? "Selected" : "Review →"); button.type = "button"; button.addEventListener("click", () => openApplication(app)); actionCell.append(button); row.append(actionCell);
      el.appBody.append(row);
    }
  }
  function renderApplicationEvents(app) {
    const list = applicationEvents.filter((event) => event.loan_application_id === app.id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    el.events.replaceChildren(); el.eventCount.textContent = `${list.length} ${list.length === 1 ? "event" : "events"}`;
    if (!list.length) { el.events.append(node("p", "al-placeholder", "No activity has been recorded yet.")); return; }
    for (const ev of list) {
      const card = node("div", "al-event");
      card.append(node("strong", "", `${applicationStatuses[ev.new_status] || titleCase(ev.new_status)} · ${titleCase(ev.event_type)}`), node("p", "", ev.event_note), node("time", "", formatDate(ev.created_at, true)));
      el.events.append(card);
    }
  }
  function openApplication(app) {
    selectedApplication = app;
    el.detail.hidden = false;
    clearMessage(el.detailMessage);
    el.detailTitle.textContent = profilesById.get(app.user_id)?.full_name || "Loan application";
    el.detailReference.textContent = `${app.application_reference} · ${applicationStatuses[app.status] || titleCase(app.status)}`;
    el.applicant.textContent = profilesById.get(app.user_id)?.full_name || "Customer name unavailable";
    el.amount.textContent = formatMoney(app.requested_amount, app.currency);
    el.term.textContent = app.requested_term_months ? `${app.requested_term_months} months` : "Not specified";
    el.date.textContent = formatDate(app.created_at, true);
    el.purpose.textContent = app.purpose;
    el.approvedAmount.value = app.approved_amount ?? app.requested_amount;
    el.approvedTerm.value = app.approved_term_months ? String(app.approved_term_months) : (app.requested_term_months ? String(app.requested_term_months) : "");
    el.reason.value = "";
    const finalStatus = ["approved", "rejected", "withdrawn"].includes(app.status);
    for (const input of el.reviewForm.querySelectorAll("input,select,textarea,button")) input.disabled = finalStatus;
    el.reviewHelper.textContent = finalStatus
      ? "This application has a final status. In this first version, final loan decisions cannot be changed from this workspace."
      : "Approval records a decision, not payment. A customer must submit a separate withdrawal request after approval.";
    if (finalStatus) el.newStatus.value = app.status;
    else el.newStatus.value = app.status === "submitted" ? "under_review" : app.status;
    toggleApprovedFields();
    renderApplicationEvents(app);
    renderApplications();
    el.detail.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function toggleApprovedFields() {
    const isApproval = el.newStatus.value === "approved";
    el.approvedFields.hidden = !isApproval;
    el.approvedAmount.required = isApproval;
  }
  function summarizeDestination(request, revealed) {
    const d = request.destination_details || {};
    const lines = [];
    if (request.method === "bank_transfer") {
      lines.push(`Bank: ${d.bank_name || "Not supplied"}`, `Account holder: ${d.account_name || "Not supplied"}`, `Account number: ${revealed ? (d.account_number || "Not supplied") : maskValue(d.account_number)}`);
      if (d.country) lines.push(`Country: ${d.country}`);
      if (d.routing_number) lines.push(`Routing / sort code: ${revealed ? d.routing_number : maskValue(d.routing_number)}`);
    } else if (request.method === "crypto") {
      lines.push(`Asset: ${d.asset || "Not supplied"}`, `Network: ${d.network || "Not supplied"}`, `Wallet: ${revealed ? (d.wallet_address || "Not supplied") : maskValue(d.wallet_address)}`);
    } else {
      lines.push(`Requested method: ${d.details || "Not supplied"}`);
    }
    return lines.join("\n");
  }
  function maskValue(value) {
    const text = String(value || ""); if (!text) return "Not supplied"; if (text.length <= 8) return `${"•".repeat(Math.max(0, text.length - 2))}${text.slice(-2)}`;
    return `${text.slice(0, 3)}${"•".repeat(Math.min(12, text.length - 7))}${text.slice(-4)}`;
  }
  function allowedWithdrawalStatuses(status) {
    if (status === "requested") return ["approved", "denied"];
    if (status === "approved") return ["processing", "denied"];
    if (status === "processing") return ["paid", "failed"];
    return [];
  }
  function renderWithdrawals() {
    el.withdrawals.replaceChildren();
    el.withdrawalCount.textContent = `${withdrawals.length} ${withdrawals.length === 1 ? "request" : "requests"}`;
    el.withdrawalsEmpty.hidden = withdrawals.length > 0;
    el.metricWithdrawals.textContent = String(withdrawals.filter((w) => ["requested", "approved", "processing"].includes(w.status)).length);
    if (!withdrawals.length) { el.withdrawals.append(node("p", "al-placeholder", "No loan withdrawal requests have been submitted.")); return; }
    for (const request of withdrawals) {
      const app = applications.find((a) => a.id === request.loan_application_id);
      const customer = profilesById.get(request.user_id)?.full_name || "Customer";
      const card = node("article", "al-withdrawal-card");
      const left = node("div", "al-withdrawal-info");
      const head = node("div", "al-withdrawal-head"); const headText = node("div");
      headText.append(node("strong", "", request.withdrawal_reference), node("p", "", `${customer} · ${app?.application_reference || "Loan application"}`));
      head.append(headText, pill(request.status, withdrawalStatuses)); left.append(head);
      left.append(node("div", "al-withdrawal-amount", formatMoney(request.amount, request.currency)));
      left.append(node("p", "", `${request.method === "bank_transfer" ? "Bank transfer" : request.method === "crypto" ? "Cryptocurrency" : "Other method"} · Submitted ${formatDate(request.created_at, true)}`));
      const destination = node("div", "al-destination-box"); destination.append(node("strong", "", "Payout destination (sensitive)"));
      const destinationValue = node("div", "al-destination-value", summarizeDestination(request, destinationRevealed.has(request.id)));
      destination.append(destinationValue);
      if (["bank_transfer", "crypto"].includes(request.method)) {
        const reveal = node("button", "al-reveal-button", destinationRevealed.has(request.id) ? "Hide sensitive details" : "Reveal destination details"); reveal.type = "button";
        reveal.addEventListener("click", () => { if (destinationRevealed.has(request.id)) destinationRevealed.delete(request.id); else destinationRevealed.add(request.id); renderWithdrawals(); });
        destination.append(reveal);
      }
      left.append(destination);
      if (request.decision_reason) left.append(node("p", "al-destination-value", `Latest note: ${request.decision_reason}`));
      if (request.provider_reference) left.append(node("p", "al-destination-value", `Transaction reference: ${request.provider_reference}`));
      card.append(left);
      const actions = node("div", "al-withdrawal-actions");
      const allowed = allowedWithdrawalStatuses(request.status);
      if (!allowed.length) {
        actions.append(node("h4", "", "Request complete"), node("p", "al-destination-value", request.status === "paid" ? "Marked paid with a transaction reference." : "This request has a final status. The customer can submit again only if the request was denied or failed."));
      } else {
        actions.append(node("h4", "", "Update withdrawal status"));
        const form = node("form", "al-form");
        const statusLabel = node("label", "", "Next status"); const statusSelect = node("select");
        for (const status of allowed) { const option = node("option", "", withdrawalStatuses[status]); option.value = status; statusSelect.append(option); }
        statusLabel.append(statusSelect); form.append(statusLabel);
        const reasonLabel = node("label", "", "Reason / processing note"); const reason = node("textarea"); reason.rows = 3; reason.maxLength = 2000; reason.placeholder = "Required for denial or failed transfer";
        reasonLabel.append(reason); form.append(reasonLabel);
        const refLabel = node("label", "", "Transaction reference (required when marking paid)"); const ref = node("input"); ref.maxLength = 200; ref.placeholder = "Provider / bank reference";
        refLabel.append(ref); form.append(refLabel);
        const submit = node("button", "al-primary-button", "Save status"); submit.type = "submit"; form.append(submit);
        statusSelect.addEventListener("change", () => {
          const mustReason = ["denied", "failed"].includes(statusSelect.value);
          reason.required = mustReason;
          ref.required = statusSelect.value === "paid";
        });
        form.addEventListener("submit", async (event) => {
          event.preventDefault(); if (busy) return;
          const nextStatus = statusSelect.value;
          if (["denied", "failed"].includes(nextStatus) && reason.value.trim().length < 3) { message(el.message, "Provide a reason when denying or failing a withdrawal.", "error"); return; }
          if (nextStatus === "paid" && ref.value.trim().length < 3) { message(el.message, "Enter a confirmed transaction reference before marking this withdrawal paid.", "error"); return; }
          await updateWithdrawal(request, nextStatus, reason.value.trim() || null, ref.value.trim() || null, submit);
        });
        actions.append(form);
      }
      card.append(actions); el.withdrawals.append(card);
    }
  }
  async function updateWithdrawal(request, nextStatus, reason, providerRef, button) {
    busy = true; clearMessage(el.message); button.disabled = true; button.textContent = "Saving…";
    try {
      const { error } = await client.rpc("admin_update_loan_withdrawal_status", {
        p_withdrawal_request_id: request.id,
        p_new_status: nextStatus,
        p_reason: reason,
        p_provider_reference: providerRef
      });
      if (error) throw error;
      destinationRevealed.delete(request.id);
      await loadData();
      message(el.message, `Withdrawal ${request.withdrawal_reference} updated to ${withdrawalStatuses[nextStatus]}.`, "success");
    } catch (error) {
      console.error("Update loan withdrawal failed:", error);
      message(el.message, error.message || "Could not update the withdrawal. Refresh and try again.", "error");
    } finally { busy = false; button.disabled = false; if (button.isConnected) button.textContent = "Save status"; }
  }
  async function submitReview(event) {
    event.preventDefault(); if (!selectedApplication || busy) return;
    clearMessage(el.detailMessage);
    const status = el.newStatus.value;
    const reason = el.reason.value.trim();
    if (["rejected", "additional_information_required"].includes(status) && reason.length < 3) {
      message(el.detailMessage, "Enter a reason for rejection or instructions for the requested information.", "error"); return;
    }
    let amount = null;
    let term = null;
    if (status === "approved") {
      amount = el.approvedAmount.value === "" ? null : Number(el.approvedAmount.value);
      term = el.approvedTerm.value ? Number(el.approvedTerm.value) : null;
      if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || amount > Number(selectedApplication.requested_amount))) {
        message(el.detailMessage, "The approved amount must be positive and cannot exceed the requested amount.", "error"); return;
      }
    }
    busy = true; el.reviewButton.disabled = true; el.reviewButton.textContent = "Saving decision…";
    try {
      const { error } = await client.rpc("admin_review_loan_application", {
        p_loan_application_id: selectedApplication.id,
        p_new_status: status,
        p_approved_amount: amount,
        p_approved_term_months: term,
        p_reason: reason || null
      });
      if (error) throw error;
      const ref = selectedApplication.application_reference;
      await loadData();
      const refreshed = applications.find((app) => app.id === selectedApplication?.id);
      if (refreshed) openApplication(refreshed); else { selectedApplication = null; el.detail.hidden = true; }
      message(el.message, `${ref}: decision saved as ${applicationStatuses[status] || titleCase(status)}.`, "success");
    } catch (error) {
      console.error("Loan application review failed:", error);
      message(el.detailMessage, error.message || "Could not save the decision. Check the application status and try again.", "error");
    } finally {
      busy = false;
      const isFinal = selectedApplication && ["approved", "rejected", "withdrawn"].includes(selectedApplication.status);
      el.reviewButton.disabled = Boolean(isFinal);
      el.reviewButton.textContent = "Save decision";
    }
  }
  async function loadData() {
    const [appsRes, withdrawalsRes, appEventsRes, withdrawalEventsRes] = await Promise.all([
      client.from("loan_applications").select("id,application_reference,user_id,requested_amount,currency,purpose,requested_term_months,status,approved_amount,approved_term_months,decision_reason,reviewed_by,reviewed_at,created_at,updated_at").order("created_at", { ascending: false }),
      client.from("loan_withdrawal_requests").select("id,withdrawal_reference,loan_application_id,user_id,amount,currency,method,destination_details,status,decision_reason,provider_reference,reviewed_by,reviewed_at,paid_at,created_at,updated_at").order("created_at", { ascending: false }),
      client.from("loan_application_events").select("id,loan_application_id,actor_id,event_type,previous_status,new_status,event_note,customer_visible,created_at").order("created_at", { ascending: true }),
      client.from("loan_withdrawal_events").select("id,withdrawal_request_id,actor_id,previous_status,new_status,event_note,customer_visible,created_at").order("created_at", { ascending: true })
    ]);
    for (const result of [appsRes, withdrawalsRes, appEventsRes, withdrawalEventsRes]) if (result.error) throw result.error;
    applications = appsRes.data || [];
    withdrawals = withdrawalsRes.data || [];
    applicationEvents = appEventsRes.data || [];
    withdrawalEvents = withdrawalEventsRes.data || [];
    const userIds = Array.from(new Set([...applications.map((a) => a.user_id), ...withdrawals.map((w) => w.user_id)].filter(Boolean)));
    profilesById = new Map();
    if (userIds.length) {
      const profileRes = await client.from("profiles").select("id,full_name").in("id", userIds);
      if (profileRes.error) throw profileRes.error;
      for (const profile of profileRes.data || []) profilesById.set(profile.id, profile);
    }
    el.metricTotal.textContent = String(applications.length);
    el.metricPending.textContent = String(applications.filter((a) => ["submitted", "under_review", "additional_information_required"].includes(a.status)).length);
    el.metricApproved.textContent = String(applications.filter((a) => a.status === "approved").length);
    renderApplications(); renderWithdrawals();
    if (selectedApplication) {
      const refreshed = applications.find((a) => a.id === selectedApplication.id);
      if (refreshed) openApplication(refreshed);
      else { selectedApplication = null; el.detail.hidden = true; }
    }
  }
  async function checkAdmin() {
    if (!window.refundSupabaseReady || !client) {
      message(el.message, "Supabase is not connected. Check js/config.js and js/supabase-client.js, then reload.", "error"); return false;
    }
    const { data, error } = await client.auth.getSession(); if (error) throw error;
    currentUser = data?.session?.user || null;
    if (!currentUser) { window.location.replace("../login.html?next=admin/loans.html"); return false; }
    const { data: roles, error: rolesError } = await client.from("user_roles").select("role").eq("user_id", currentUser.id);
    if (rolesError) throw rolesError;
    const roleNames = (roles || []).map((r) => r.role);
    currentRole = roleNames.includes("super_admin") ? "super_admin" : roleNames.includes("admin") ? "admin" : null;
    if (!currentRole) {
      el.email.textContent = currentUser.email || "Signed-in user"; el.role.textContent = "No administrator role";
      message(el.message, "Access denied. This workspace is restricted to administrators.", "error"); return false;
    }
    el.email.textContent = currentUser.email || "Administrator";
    el.role.textContent = currentRole === "super_admin" ? "Super administrator" : "Administrator";
    return true;
  }
  function wireEvents() {
    el.refresh.addEventListener("click", async () => { try { clearMessage(el.message); await loadData(); message(el.message, "Loan data refreshed.", "success"); } catch (error) { console.error(error); message(el.message, error.message || "Could not refresh loan data.", "error"); } });
    el.search.addEventListener("input", renderApplications);
    el.filter.addEventListener("change", renderApplications);
    el.newStatus.addEventListener("change", toggleApprovedFields);
    el.reviewForm.addEventListener("submit", submitReview);
    el.closeDetail.addEventListener("click", () => { selectedApplication = null; el.detail.hidden = true; renderApplications(); });
    el.signOut.addEventListener("click", async () => { try { await client.auth.signOut(); } finally { window.location.assign("../login.html"); } });
    client.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") window.location.replace("../login.html"); });
  }
  async function init() {
    try {
      if (!window.refundSupabaseReady || !client) { message(el.message, "Supabase is not connected. Check js/config.js and js/supabase-client.js, then reload.", "error"); return; }
      const allowed = await checkAdmin();
      if (!allowed) return;
      wireEvents(); await loadData();
    } catch (error) {
      console.error("Admin loan workspace initialization failed:", error);
      message(el.message, error.message || "Could not initialize the loan workspace.", "error");
    }
  }
  init();
})();
