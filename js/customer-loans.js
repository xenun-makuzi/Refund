(() => {
  "use strict";
  const client = window.refundSupabase;
  const $ = (selector) => document.querySelector(selector);
  const el = {
    email: $("#loan-user-email"), signOut: $("#loan-sign-out"), message: $("#loan-page-message"),
    notice: $("#loan-verification-notice"), noticeTitle: $("#loan-verification-title"), noticeCopy: $("#loan-verification-copy"),
    total: $("#loan-metric-total"), approved: $("#loan-metric-approved"), withdrawals: $("#loan-metric-withdrawals"),
    applyForm: $("#loan-application-form"), applyButton: $("#loan-application-submit"),
    amount: $("#requested-amount"), currency: $("#loan-currency"), purpose: $("#loan-purpose"), term: $("#requested-term"),
    refresh: $("#loan-refresh"), applications: $("#loan-applications-list"),
    withdrawalPanel: $("#loan-withdrawal-panel"), withdrawalForm: $("#loan-withdrawal-form"),
    withdrawalContext: $("#withdrawal-context"), withdrawalAmount: $("#withdrawal-approved-amount"),
    withdrawalApplicationId: $("#withdrawal-application-id"), withdrawalMethod: $("#withdrawal-method"),
    bankFields: $("#withdrawal-bank-fields"), cryptoFields: $("#withdrawal-crypto-fields"), otherFields: $("#withdrawal-other-fields"),
    withdrawalSubmit: $("#loan-withdrawal-submit"), withdrawalCancel: $("#loan-withdrawal-cancel")
  };
  const appStatuses = {
    submitted: "Submitted", under_review: "Under review",
    additional_information_required: "More information required", approved: "Approved",
    rejected: "Rejected", withdrawn: "Withdrawn"
  };
  const withdrawalStatuses = {
    requested: "Awaiting review", approved: "Approved", denied: "Denied",
    processing: "Processing", paid: "Paid", failed: "Failed"
  };
  const activeWithdrawal = new Set(["requested", "approved", "processing", "paid"]);
  let currentUser = null;
  let currentProfile = null;
  let applications = [];
  let withdrawals = [];
  let applicationEvents = [];
  let withdrawalEvents = [];
  let submitting = false;

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }
  function showMessage(text, kind = "info") {
    el.message.hidden = false;
    el.message.className = `loan-message${kind === "error" ? " is-error" : kind === "warning" ? " is-warning" : ""}`;
    el.message.textContent = text;
    el.message.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function clearMessage() { el.message.hidden = true; el.message.textContent = ""; el.message.className = "loan-message"; }
  function formatMoney(value, currency = "USD") {
    const amount = Number(value);
    const code = String(currency || "USD").trim().toUpperCase();
    if (!Number.isFinite(amount)) return "—";
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: code, maximumFractionDigits: 2 }).format(amount); }
    catch { return `${code} ${amount.toFixed(2)}`; }
  }
  function formatDate(value, withTime = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(date);
  }
  function titleCase(value) { return String(value || "Unknown").replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
  function statusClass(status) {
    if (["approved", "paid"].includes(status)) return "is-approved";
    if (["rejected", "denied", "failed", "withdrawn"].includes(status)) return "is-rejected";
    if (["under_review", "additional_information_required", "requested", "processing"].includes(status)) return status === "processing" ? "is-processing" : "is-review";
    return "";
  }
  function statusPill(status, labels) { return node("span", `loan-status ${statusClass(status)}`, labels[status] || titleCase(status)); }
  function latestWithdrawal(applicationId) {
    return withdrawals.filter((w) => w.loan_application_id === applicationId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
  }
  function eventsForApplication(id) { return applicationEvents.filter((event) => event.loan_application_id === id); }
  function eventsForWithdrawal(id) { return withdrawalEvents.filter((event) => event.withdrawal_request_id === id); }
  function setProfileNotice() {
    const accountStatus = currentProfile?.account_status || "active";
    const identityStatus = currentProfile?.identity_status || "unsubmitted";
    if (accountStatus !== "active") {
      el.notice.hidden = false;
      el.noticeTitle.textContent = "Account access is restricted";
      el.noticeCopy.textContent = "Loan withdrawals are unavailable while your account is not active. Contact support if you need help.";
    } else if (identityStatus !== "verified") {
      el.notice.hidden = false;
      el.noticeTitle.textContent = "Identity verification required for withdrawals";
      el.noticeCopy.textContent = "You can submit a loan application now, but your identity must be marked verified before you can request withdrawal of an approved loan.";
    } else {
      el.notice.hidden = true;
    }
  }
  function appendMeta(container, label, value) {
    const line = node("div", "loan-request-meta-line");
    line.append(node("span", "", label), node("strong", "", value));
    container.append(line);
  }
  function renderApplications() {
    el.applications.replaceChildren();
    el.total.textContent = String(applications.length);
    el.approved.textContent = String(applications.filter((a) => a.status === "approved").length);
    el.withdrawals.textContent = String(withdrawals.filter((w) => ["requested", "approved", "processing"].includes(w.status)).length);
    if (!applications.length) {
      const empty = node("div", "loan-empty-state");
      empty.append(node("strong", "", "No loan applications yet"), node("p", "", "Submit your first application using the form above. Your request will appear here once saved."));
      el.applications.append(empty);
      return;
    }
    const sorted = [...applications].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    sorted.forEach((app, index) => {
      const card = node("article", "loan-application-card");
      card.style.animationDelay = `${Math.min(index * 35, 200)}ms`;
      const top = node("div", "loan-application-top");
      const refWrap = node("div");
      refWrap.append(node("div", "loan-reference", app.application_reference), node("div", "loan-application-date", `Submitted ${formatDate(app.created_at)}`));
      top.append(refWrap, statusPill(app.status, appStatuses));
      card.append(top);
      card.append(node("div", "loan-request-amount", formatMoney(app.requested_amount, app.currency)));
      card.append(node("div", "loan-request-meta", "Amount requested"));
      const meta = node("div", "loan-card-meta");
      appendMeta(meta, "Preferred term", app.requested_term_months ? `${app.requested_term_months} months` : "Not specified");
      if (app.status === "approved") {
        appendMeta(meta, "Approved amount", formatMoney(app.approved_amount, app.currency));
        appendMeta(meta, "Approved term", app.approved_term_months ? `${app.approved_term_months} months` : "Not specified");
      }
      card.append(meta);
      card.append(node("p", "loan-purpose-copy", app.purpose));
      const matchingEvents = eventsForApplication(app.id).slice(-2).reverse();
      if (matchingEvents.length) {
        const activity = node("div", "loan-recent-activity");
        activity.append(node("strong", "", "Recent update"));
        for (const ev of matchingEvents) {
          const row = node("p", "", `${formatDate(ev.created_at, true)} · ${ev.event_note}`);
          activity.append(row);
        }
        card.append(activity);
      }
      if (app.decision_reason) {
        const decision = node("div", "loan-decision-box");
        decision.append(node("strong", "", "Latest decision note"), node("span", "", app.decision_reason));
        card.append(decision);
      }
      const oldWithdrawal = latestWithdrawal(app.id);
      if (oldWithdrawal) {
        const withdrawalBox = node("div", "loan-card-withdrawal");
        const wTop = node("div", "loan-card-withdrawal-top");
        wTop.append(node("strong", "", `Withdrawal ${oldWithdrawal.withdrawal_reference}`), statusPill(oldWithdrawal.status, withdrawalStatuses));
        withdrawalBox.append(wTop);
        const eventList = eventsForWithdrawal(oldWithdrawal.id).slice(-2).reverse();
        const latestNote = oldWithdrawal.decision_reason || eventList[0]?.event_note || "Track changes here as the team updates your request.";
        withdrawalBox.append(node("p", "", `${formatMoney(oldWithdrawal.amount, oldWithdrawal.currency)} via ${oldWithdrawal.method === "bank_transfer" ? "Bank transfer" : oldWithdrawal.method === "crypto" ? "Cryptocurrency" : "Other method"} · Submitted ${formatDate(oldWithdrawal.created_at)}.`));
        withdrawalBox.append(node("p", "", latestNote));
        if (oldWithdrawal.provider_reference && oldWithdrawal.status === "paid") withdrawalBox.append(node("p", "", `Payment reference: ${oldWithdrawal.provider_reference}`));
        card.append(withdrawalBox);
      }
      if (app.status === "approved") {
        const actions = node("div", "loan-card-actions");
        if (oldWithdrawal && activeWithdrawal.has(oldWithdrawal.status)) {
          actions.append(node("span", "loan-request-meta", oldWithdrawal.status === "paid" ? "This loan withdrawal is marked paid." : "A withdrawal request is already active."));
        } else if (currentProfile?.account_status !== "active" || currentProfile?.identity_status !== "verified") {
          const disabled = node("button", "loan-small-button", "Withdrawal requires verification");
          disabled.type = "button"; disabled.disabled = true; actions.append(disabled);
        } else {
          const button = node("button", "loan-small-button", oldWithdrawal ? "Request withdrawal again" : "Request loan withdrawal");
          button.type = "button";
          button.addEventListener("click", () => openWithdrawalForm(app));
          actions.append(button);
        }
        card.append(actions);
      }
      el.applications.append(card);
    });
  }
  function openWithdrawalForm(app) {
    if (currentProfile?.account_status !== "active" || currentProfile?.identity_status !== "verified") {
      showMessage("Your account must be active and your identity verified before requesting withdrawal.", "warning");
      return;
    }
    el.withdrawalApplicationId.value = app.id;
    el.withdrawalContext.textContent = `${app.application_reference} · Approved loan. The request is for the full approved amount.`;
    el.withdrawalAmount.textContent = formatMoney(app.approved_amount, app.currency);
    el.withdrawalPanel.hidden = false;
    renderDestinationFields();
    el.withdrawalPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderDestinationFields() {
    const method = el.withdrawalMethod.value;
    el.bankFields.hidden = method !== "bank_transfer";
    el.cryptoFields.hidden = method !== "crypto";
    el.otherFields.hidden = method !== "other";
  }
  function destinationPayload() {
    const method = el.withdrawalMethod.value;
    if (method === "bank_transfer") {
      const payload = {
        bank_name: $("#loan-bank-name").value.trim(),
        account_name: $("#loan-account-name").value.trim(),
        account_number: $("#loan-account-number").value.trim()
      };
      const country = $("#loan-bank-country").value.trim();
      const routing = $("#loan-routing-number").value.trim();
      if (country) payload.country = country;
      if (routing) payload.routing_number = routing;
      if (payload.bank_name.length < 2 || payload.account_name.length < 2 || payload.account_number.length < 4) {
        throw new Error("Enter the bank name, account-holder name, and account number.");
      }
      return payload;
    }
    if (method === "crypto") {
      const payload = {
        asset: $("#loan-crypto-asset").value.trim(),
        network: $("#loan-crypto-network").value.trim(),
        wallet_address: $("#loan-wallet-address").value.trim()
      };
      if (payload.asset.length < 2 || payload.network.length < 2 || payload.wallet_address.length < 10) {
        throw new Error("Enter the asset, network, and destination wallet address.");
      }
      return payload;
    }
    const details = $("#loan-other-details").value.trim();
    if (details.length < 5) throw new Error("Describe the other payout method.");
    return { details };
  }
  async function loadData() {
    if (!client) throw new Error("Supabase client is unavailable. Check js/config.js and js/supabase-client.js.");
    const [profileResult, appResult, withdrawalResult, appEventResult, withdrawalEventResult] = await Promise.all([
      client.from("profiles").select("id, full_name, identity_status, account_status").eq("id", currentUser.id).maybeSingle(),
      client.from("loan_applications").select("id, application_reference, user_id, requested_amount, currency, purpose, requested_term_months, status, approved_amount, approved_term_months, decision_reason, reviewed_at, created_at, updated_at").order("created_at", { ascending: false }),
      client.from("loan_withdrawal_requests").select("id, withdrawal_reference, loan_application_id, amount, currency, method, status, decision_reason, provider_reference, created_at, updated_at, paid_at").order("created_at", { ascending: false }),
      client.from("loan_application_events").select("id, loan_application_id, event_type, new_status, event_note, created_at").eq("customer_visible", true).order("created_at", { ascending: true }),
      client.from("loan_withdrawal_events").select("id, withdrawal_request_id, new_status, event_note, created_at").eq("customer_visible", true).order("created_at", { ascending: true })
    ]);
    for (const result of [profileResult, appResult, withdrawalResult, appEventResult, withdrawalEventResult]) if (result.error) throw result.error;
    currentProfile = profileResult.data || null;
    applications = appResult.data || [];
    withdrawals = withdrawalResult.data || [];
    applicationEvents = appEventResult.data || [];
    withdrawalEvents = withdrawalEventResult.data || [];
    setProfileNotice();
    renderApplications();
  }
  async function submitApplication(event) {
    event.preventDefault();
    if (submitting) return;
    clearMessage();
    const amount = Number(el.amount.value);
    const purpose = el.purpose.value.trim();
    const term = el.term.value ? Number(el.term.value) : null;
    if (!Number.isFinite(amount) || amount <= 0) { showMessage("Enter a valid loan amount.", "error"); return; }
    if (purpose.length < 10) { showMessage("Please explain the purpose of the loan in at least 10 characters.", "error"); return; }
    submitting = true; el.applyButton.disabled = true; el.applyButton.querySelector("span:first-child").textContent = "Submitting…";
    try {
      const { error } = await client.rpc("submit_loan_application", {
        p_requested_amount: amount,
        p_currency: el.currency.value,
        p_purpose: purpose,
        p_requested_term_months: term
      });
      if (error) throw error;
      el.applyForm.reset();
      showMessage("Your loan application has been submitted. You can track its status below.", "success");
      await loadData();
    } catch (error) {
      console.error("Loan application submission failed:", error);
      showMessage(error.message || "The application could not be submitted. Please try again.", "error");
    } finally {
      submitting = false; el.applyButton.disabled = false; el.applyButton.querySelector("span:first-child").textContent = "Submit application";
    }
  }
  async function submitWithdrawal(event) {
    event.preventDefault();
    if (submitting) return;
    clearMessage();
    const applicationId = el.withdrawalApplicationId.value;
    if (!applicationId) { showMessage("Select an approved loan first.", "error"); return; }
    let destination;
    try { destination = destinationPayload(); }
    catch (error) { showMessage(error.message, "error"); return; }
    submitting = true; el.withdrawalSubmit.disabled = true; el.withdrawalSubmit.querySelector("span:first-child").textContent = "Submitting request…";
    try {
      const { error } = await client.rpc("request_loan_withdrawal", {
        p_loan_application_id: applicationId,
        p_method: el.withdrawalMethod.value,
        p_destination_details: destination
      });
      if (error) throw error;
      el.withdrawalForm.reset();
      el.withdrawalPanel.hidden = true;
      showMessage("Your loan withdrawal request has been submitted for administrator review. No funds have been transferred by this action.", "success");
      await loadData();
    } catch (error) {
      console.error("Loan withdrawal request failed:", error);
      showMessage(error.message || "Your withdrawal request could not be submitted.", "error");
    } finally {
      submitting = false; el.withdrawalSubmit.disabled = false; el.withdrawalSubmit.querySelector("span:first-child").textContent = "Submit withdrawal request";
    }
  }
  function wireEvents() {
    el.applyForm.addEventListener("submit", submitApplication);
    el.withdrawalForm.addEventListener("submit", submitWithdrawal);
    el.withdrawalMethod.addEventListener("change", renderDestinationFields);
    el.withdrawalCancel.addEventListener("click", () => { el.withdrawalPanel.hidden = true; el.withdrawalForm.reset(); });
    el.refresh.addEventListener("click", async () => { clearMessage(); try { await loadData(); showMessage("Your loan information has been refreshed.", "success"); } catch (error) { showMessage(error.message || "Could not refresh loan data.", "error"); } });
    el.signOut.addEventListener("click", async () => { try { await client.auth.signOut(); } finally { window.location.assign("../login.html"); } });
    client.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") window.location.replace("../login.html"); });
  }
  async function init() {
    if (!window.refundSupabaseReady || !client) {
      showMessage("Supabase is not connected. Check js/config.js and js/supabase-client.js, save your files, and reload.", "error");
      el.applications.replaceChildren(node("div", "loan-empty-state", "Connect Supabase to load your loan applications."));
      return;
    }
    try {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      currentUser = data?.session?.user || null;
      if (!currentUser) { window.location.replace("../login.html?next=customer/loans.html"); return; }
      el.email.textContent = currentUser.email || "Signed-in customer";
      wireEvents();
      await loadData();
    } catch (error) {
      console.error("Loan workspace initialization failed:", error);
      showMessage(error.message || "Could not load the loan workspace. Refresh and try again.", "error");
      el.applications.replaceChildren(node("div", "loan-empty-state", "Loan records could not be loaded."));
    }
  }
  init();
})();
