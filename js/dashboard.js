(() => {
  "use strict";

  const client = window.refundSupabase;
  const $ = (selector) => document.querySelector(selector);
  const activeClaimStatuses = ["submitted", "under_review", "awaiting_information", "investigation_in_progress", "recovery_in_progress", "partially_recovered"];
  const activePayoutStatuses = ["requested", "approved", "processing"];
  const activeSupportStatuses = ["open", "in_progress", "waiting_for_customer", "escalated"];
  let currentUser = null;
  let currentProfile = null;
  let loading = false;
  let latestClaims = [];
  let recoveryBalances = [];
  let latestNotifications = [];
  let latestLoans = [];
  const partialErrors = new Set();

  const statusLabels = {
    submitted: "Submitted", under_review: "Under review", awaiting_information: "Awaiting information",
    investigation_in_progress: "Investigation in progress", recovery_in_progress: "Recovery in progress",
    partially_recovered: "Partially recovered", recovery_complete: "Recovery complete",
    not_eligible: "Not eligible", closed: "Closed", additional_information_required: "More information needed",
    approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn", requested: "Requested",
    denied: "Denied", processing: "Processing", paid: "Paid", failed: "Failed", open: "Open",
    in_progress: "In progress", waiting_for_customer: "Waiting for you", escalated: "Escalated",
    resolved: "Resolved", pending: "Pending", verified: "Verified", action_required: "Action required",
    unsubmitted: "Not submitted", suspended: "Suspended", active: "Active", closed_account: "Closed"
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function formatMoney(value, currency) {
    const amount = Number(value);
    const code = String(currency || "USD").trim().toUpperCase();
    if (!Number.isFinite(amount)) return "—";
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: code, maximumFractionDigits: 2 }).format(amount);
    } catch {
      return `${code} ${amount.toFixed(2)}`;
    }
  }

  function formatDate(value, includeTime = false) {
    if (!value) return "Date unavailable";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    return new Intl.DateTimeFormat(undefined, includeTime
      ? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", year: "numeric" }).format(date);
  }

  function labelForStatus(status) {
    return statusLabels[status] || String(status || "Unknown").replaceAll("_", " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  function setGlobalMessage(text, kind = "info") {
    const box = $("#dashboard-global-message");
    if (!box) return;
    box.hidden = !text;
    box.className = `dashboard-alert${kind === "error" ? " is-error" : kind === "success" ? " is-success" : ""}`;
    box.textContent = text || "";
  }

  function statusClass(status) {
    if (["approved", "paid", "recovery_complete", "verified", "resolved", "closed"].includes(status)) return "status-positive";
    if (["rejected", "not_eligible", "failed", "denied", "suspended"].includes(status)) return "status-danger";
    if (["awaiting_information", "additional_information_required", "waiting_for_customer", "pending", "requested", "under_review", "processing", "escalated"].includes(status)) return "status-warning";
    return "";
  }

  function statusPill(status) {
    return node("span", `status-pill ${statusClass(status)}`, labelForStatus(status));
  }

  async function read(label, query) {
    try {
      const result = await query;
      if (result.error) {
        partialErrors.add(label);
        console.error(`Refund dashboard: ${label} query failed:`, result.error.message);
        return { data: null, count: null, error: result.error };
      }
      return { data: result.data, count: result.count ?? null, error: null };
    } catch (error) {
      partialErrors.add(label);
      console.error(`Refund dashboard: ${label} request failed:`, error);
      return { data: null, count: null, error };
    }
  }

  function setGreeting(profile) {
    const name = String(profile?.full_name || currentUser?.user_metadata?.full_name || "").trim();
    const firstName = name && name !== "New Customer" ? name.split(/\s+/)[0] : "";
    $("#customer-first-name").textContent = firstName ? ` ${firstName}` : "";
    $("#welcome-name-punctuation").textContent = firstName ? "," : ".";
    $("#topbar-user-name").textContent = name && name !== "New Customer" ? name : "Your account";
    $("#topbar-user-email").textContent = currentUser?.email || "Signed in";
    $("#customer-avatar").textContent = (firstName || currentUser?.email || "R").charAt(0).toUpperCase();
  }

  function renderIdentity(profile) {
    const strip = $("#identity-strip");
    const icon = $("#identity-symbol");
    const title = $("#identity-title");
    const desc = $("#identity-description");
    const badge = $("#identity-badge");
    const panel = $("#identity-dashboard-card");
    const panelTitle = $("#identity-dashboard-title");
    const panelDesc = $("#identity-dashboard-description");
    const panelStatus = $("#identity-dashboard-status");
    const panelLink = $("#identity-dashboard-link");

    if (!profile) {
      strip.className = "identity-strip is-warning";
      icon.textContent = "!";
      title.textContent = "Profile setup is incomplete";
      desc.textContent = "Your authentication session is active, but your customer profile could not be loaded. Contact support if this persists.";
      badge.textContent = "Profile check";
      if (panel) panel.classList.add("is-warning");
      if (panelTitle) panelTitle.textContent = "Identity status unavailable";
      if (panelDesc) panelDesc.textContent = "We couldn't load your profile verification status. Refresh or contact support before submitting a document.";
      if (panelStatus) panelStatus.textContent = "Check required";
      if (panelLink) { panelLink.textContent = "Contact support →"; panelLink.href = "support.html"; }
      return;
    }

    const identity = profile.identity_status || "unsubmitted";
    const account = profile.account_status || "active";
    const text = {
      verified: ["Identity verified", "Your identity is marked as verified. Payout requests still require full recovery and an active account."],
      pending: ["Identity review in progress", "Your identity details are awaiting review. Payout requests remain unavailable until verification is complete."],
      rejected: ["Identity verification needs attention", "Your identity check was not approved. Review the note on the verification page and follow the next steps."],
      action_required: ["Additional identity information needed", "Please review the latest note and submit an updated document if requested."],
      unsubmitted: ["Complete identity verification", "Your identity is not yet verified. Some financial actions, including payout requests, remain unavailable."]
    };
    const selected = text[identity] || text.unsubmitted;
    const activeAndVerified = identity === "verified" && account === "active";
    strip.className = `identity-strip${activeAndVerified ? "" : identity === "rejected" || account !== "active" ? " is-danger" : " is-warning"}`;
    icon.textContent = activeAndVerified ? "✓" : "!";
    title.textContent = account !== "active" ? `Account ${labelForStatus(account).toLowerCase()}` : selected[0];
    desc.textContent = account !== "active" ? "Some actions may be restricted while your account is not active. Please contact support if you need help." : selected[1];
    badge.textContent = account !== "active" ? labelForStatus(account) : labelForStatus(identity);

    if (panel) {
      panel.classList.toggle("is-verified", activeAndVerified);
      panel.classList.toggle("is-warning", !activeAndVerified && account === "active");
      panel.classList.toggle("is-danger", account !== "active" || identity === "rejected");
    }
    if (panelTitle) panelTitle.textContent = account !== "active" ? "Account access is restricted" : ({
      verified: "Identity verification complete",
      pending: "Your documents are under review",
      rejected: "Identity review needs attention",
      action_required: "More information is needed",
      unsubmitted: "Verify your identity"
    }[identity] || "Verify your identity");
    if (panelDesc) panelDesc.textContent = account !== "active"
      ? "Identity submissions are unavailable while your account is not active. Contact support for assistance."
      : ({
          verified: "Your identity submission was approved. Payouts and other financial actions still have separate eligibility checks.",
          pending: "Your document has been submitted. Please wait for an authorized reviewer; don't submit it again while this review is pending.",
          rejected: "Your submission was not approved. Review the decision note and submit a new document if appropriate.",
          action_required: "The review team needs an update. Open verification to read the note and upload a replacement document.",
          unsubmitted: "Submit a clear government-issued document through our private upload form to start identity review."
        }[identity] || text.unsubmitted[1]);
    if (panelStatus) {
      panelStatus.textContent = account !== "active" ? labelForStatus(account) : labelForStatus(identity);
      panelStatus.className = `verification-dashboard-status${activeAndVerified ? " is-success" : identity === "rejected" || account !== "active" ? " is-danger" : " is-warning"}`;
    }
    if (panelLink) {
      panelLink.href = account !== "active" ? "support.html" : "verification.html";
      panelLink.innerHTML = account !== "active" ? "Contact support <span aria-hidden=\"true\">↗</span>" : ({
        verified: "View verification <span aria-hidden=\"true\">↗</span>",
        pending: "Check status <span aria-hidden=\"true\">↗</span>",
        rejected: "Review & resubmit <span aria-hidden=\"true\">↗</span>",
        action_required: "Update documents <span aria-hidden=\"true\">↗</span>",
        unsubmitted: "Submit ID document <span aria-hidden=\"true\">↗</span>"
      }[identity] || "Submit ID document <span aria-hidden=\"true\">↗</span>");
    }
  }

  function buildCircularProgress(percent) {
    const circumference = 2 * Math.PI * 24;
    const wrapper = node("div", "recovery-ring-wrap");
    wrapper.setAttribute("role", "img");
    wrapper.setAttribute("aria-label", `Recovery progress ${Math.round(percent)} percent`);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 64 64");
    svg.setAttribute("aria-hidden", "true");
    const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    track.setAttribute("cx", "32"); track.setAttribute("cy", "32"); track.setAttribute("r", "24");
    track.setAttribute("class", "recovery-ring-track");
    const arc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    arc.setAttribute("cx", "32"); arc.setAttribute("cy", "32"); arc.setAttribute("r", "24");
    arc.setAttribute("class", "recovery-ring-arc");
    arc.style.strokeDasharray = String(circumference);
    arc.style.strokeDashoffset = String(circumference * (1 - Math.min(100, Math.max(0, percent)) / 100));
    svg.append(track, arc);
    wrapper.append(svg, node("span", "recovery-ring-label", `${Math.round(percent)}%`));
    return wrapper;
  }

  function renderMetrics({ activeClaimsCount, recoveryCount, approvedLoansCount, unreadCount }) {
    $("#metric-active-claims").textContent = activeClaimsCount === null ? "—" : String(activeClaimsCount);
    $("#metric-recovery-cases").textContent = recoveryCount === null ? "—" : String(recoveryCount);
    $("#metric-approved-loans").textContent = approvedLoansCount === null ? "—" : String(approvedLoansCount);
    $("#metric-unread-updates").textContent = unreadCount === null ? "—" : String(unreadCount);
    const notifBadge = $("#nav-unread-notifications");
    const topDot = $("#topbar-notification-dot");
    notifBadge.hidden = !unreadCount;
    notifBadge.textContent = unreadCount > 99 ? "99+" : String(unreadCount || 0);
    topDot.hidden = !unreadCount;
  }

  function renderRecoverySummary(balances) {
    const target = $("#recovery-summary-grid");
    target.replaceChildren();
    if (partialErrors.has("recovery balances")) {
      const empty = node("div", "empty-panel empty-panel-compact");
      empty.append(node("span", "empty-symbol", "!"), node("strong", "", "Recovery information is temporarily unavailable"), node("p", "", "We couldn't load your recovery ledger. Use Refresh to try again; no balance has been estimated."));
      target.append(empty);
      return;
    }
    if (!balances.length) {
      const empty = node("div", "empty-panel empty-panel-compact");
      empty.append(
        node("span", "empty-symbol", "↗"),
        node("strong", "", "No recovery balances available yet"),
        node("p", "", "A recovery overview appears after an administrator configures a recovery target for one of your claims and verified ledger entries are recorded."),
        node("a", "", "Open claims workspace →")
      );
      empty.querySelector("a").href = "claims.html";
      target.append(empty);
      return;
    }
    const totals = new Map();
    for (const row of balances) {
      const currency = String(row.currency || "USD").trim().toUpperCase();
      const item = totals.get(currency) || { currency, target: 0, recovered: 0, outstanding: 0, accounts: 0, eligible: 0 };
      item.target += Number(row.recoverable_amount) || 0;
      item.recovered += Number(row.recovered_amount) || 0;
      item.outstanding += Number(row.outstanding_amount) || 0;
      item.accounts += 1;
      if (row.payout_eligible) item.eligible += 1;
      totals.set(currency, item);
    }
    for (const item of [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency))) {
      const ratio = item.target > 0 ? Math.min(100, Math.max(0, item.recovered / item.target * 100)) : 0;
      const card = node("article", "recovery-card");
      const top = node("div", "recovery-card-top");
      const amountWrap = node("div");
      amountWrap.append(node("div", "recovery-currency-label", "RECOVERED SO FAR"), node("div", "recovery-primary-amount", formatMoney(item.recovered, item.currency)), node("div", "recovery-primary-caption", `${item.accounts} recovery ${item.accounts === 1 ? "case" : "cases"} in ${item.currency}`));
      top.append(amountWrap, buildCircularProgress(ratio), node("span", "recovery-currency-chip", item.currency));
      card.append(top);
      const progress = node("div", "recovery-progress");
      const heading = node("div", "recovery-progress-heading");
      heading.append(node("span", "", "Recovery progress"), node("strong", "", `${Math.round(ratio)}%`));
      const track = node("div", "progress-track");
      const fill = node("div", "progress-fill");
      fill.style.width = `${ratio}%`;
      track.append(fill);
      progress.append(heading, track);
      card.append(progress);
      const breakdown = node("div", "recovery-breakdown");
      const targetCell = node("div");
      targetCell.append(node("span", "", "Total recovery target"), node("strong", "", formatMoney(item.target, item.currency)));
      const outstandingCell = node("div");
      outstandingCell.append(node("span", "", "Amount remaining"), node("strong", "", formatMoney(item.outstanding, item.currency)));
      breakdown.append(targetCell, outstandingCell);
      card.append(breakdown);
      const bottom = node("div", "recovery-card-bottom");
      const payoutCopy = item.eligible > 0 ? `${item.eligible} case${item.eligible === 1 ? " is" : "s are"} eligible to request a payout` : "Payout eligibility is checked per case";
      bottom.append(node("span", "", payoutCopy));
      const link = node("a", "", "Details →"); link.href = "recovery.html";
      bottom.append(link);
      card.append(bottom);
      target.append(card);
    }
  }

  function renderClaims(claims, balances) {
    const target = $("#recent-claims-list");
    target.replaceChildren();
    const balanceByClaim = new Map(balances.map((item) => [item.claim_id, item]));
    if (partialErrors.has("claims")) {
      const empty = node("div", "empty-panel");
      empty.append(node("span", "empty-symbol", "!"), node("strong", "", "Claims could not be loaded"), node("p", "", "Your claims are not missing; this request failed. Use Refresh to try again."));
      target.append(empty);
      return;
    }
    if (!claims.length) {
      const empty = node("div", "empty-panel");
      empty.append(node("span", "empty-symbol", "▤"), node("strong", "", "No claims submitted yet"), node("p", "", "When you submit a claim, its reference and latest status will appear here."));
      const link = node("a", "", "Start your first claim →"); link.href = "claims.html"; empty.append(link);
      target.append(empty);
      return;
    }
    for (const claim of claims) {
      const row = node("article", "claim-row");
      row.append(node("span", "claim-row-icon", "▤"));
      const copy = node("div", "claim-row-copy");
      copy.append(node("strong", "claim-row-title", claim.title || claim.case_reference), node("span", "claim-row-meta", `${claim.case_reference} · Updated ${formatDate(claim.updated_at || claim.created_at)}`));
      row.append(copy, statusPill(claim.status));
      const balance = balanceByClaim.get(claim.id);
      if (balance) {
        const amount = node("span", "claim-row-meta");
        amount.textContent = `${formatMoney(balance.recovered_amount, balance.currency)} recovered · ${formatMoney(balance.outstanding_amount, balance.currency)} remaining`;
        copy.append(amount);
      }
      row.addEventListener("click", (event) => {
        if (event.target.closest("a,button")) return;
        window.location.href = `claims.html?claim=${encodeURIComponent(claim.id)}`;
      });
      row.style.cursor = "pointer";
      row.setAttribute("role", "link");
      row.setAttribute("tabindex", "0");
      row.setAttribute("aria-label", `Open claim ${claim.case_reference}`);
      row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); window.location.href = `claims.html?claim=${encodeURIComponent(claim.id)}`; } });
      target.append(row);
    }
  }

  function targetForNotification(item) {
    if (item.notification_type === "identity_verification_update") return "verification.html";
    if (item.related_support_ticket_id) return `support.html?ticket=${encodeURIComponent(item.related_support_ticket_id)}`;
    if (item.related_claim_id) return `messages.html?claim=${encodeURIComponent(item.related_claim_id)}`;
    if (item.related_loan_application_id || item.related_loan_withdrawal_request_id) return "loans.html";
    if (item.related_payout_request_id) return "recovery.html";
    return "notifications.html";
  }

  function renderUpdates(notifications) {
    const target = $("#recent-updates-list");
    target.replaceChildren();
    if (partialErrors.has("notifications")) {
      const empty = node("div", "empty-panel");
      empty.append(node("span", "empty-symbol", "!"), node("strong", "", "Updates could not be loaded"), node("p", "", "Refresh the dashboard to try loading your latest account notifications again."));
      target.append(empty);
      return;
    }
    if (!notifications.length) {
      const empty = node("div", "empty-panel");
      empty.append(node("span", "empty-symbol", "✦"), node("strong", "", "You're all caught up"), node("p", "", "New case updates, messages, and financial workflow decisions will appear here."));
      target.append(empty);
      return;
    }
    for (const item of notifications.slice(0, 4)) {
      const row = node("article", `update-row${item.is_read ? "" : " is-unread"}`);
      const icon = item.notification_type === "claim_message" ? "✉" : item.notification_type.includes("support") ? "?" : item.notification_type.includes("loan") ? "◇" : item.notification_type === "recovery_payout_update" ? "↗" : "•";
      const marker = node("span", "update-indicator", icon);
      const copy = node("div", "update-content");
      const titleLink = node("a", "", item.title || "Account update");
      titleLink.href = targetForNotification(item);
      titleLink.style.color = "inherit";
      titleLink.style.textDecoration = "none";
      const heading = node("strong"); heading.append(titleLink);
      copy.append(heading, node("p", "", item.body || "There is an update to your account."), node("time", "", formatDate(item.created_at, true)));
      row.append(marker, copy);
      target.append(row);
    }
  }

  function renderLoanRequests(applications) {
    const target = $("#recent-loans-list");
    target.replaceChildren();
    if (partialErrors.has("loan applications")) {
      const empty = node("div", "empty-panel");
      empty.append(node("span", "empty-symbol", "!"), node("strong", "", "Loan requests could not be loaded"), node("p", "", "Open the loan workspace or refresh this dashboard to try again."));
      target.append(empty);
      return;
    }
    if (!applications.length) {
      const empty = node("div", "empty-panel");
      empty.append(node("span", "empty-symbol", "◇"), node("strong", "", "No loan requests yet"), node("p", "", "When you apply for a loan, its decision and status will appear here."));
      const link = node("a", "", "Open loan workspace →"); link.href = "loans.html"; empty.append(link);
      target.append(empty);
      return;
    }
    for (const app of applications.slice(0, 4)) {
      const row = node("article", "update-row");
      row.append(node("span", "update-indicator", "◇"));
      const copy = node("div", "update-content");
      const title = node("strong", "", `${app.application_reference || "Loan request"} · ${labelForStatus(app.status)}`);
      const amount = app.status === "approved" && app.approved_amount != null
        ? `Approved amount: ${formatMoney(app.approved_amount, app.currency)}`
        : `Requested: ${formatMoney(app.requested_amount, app.currency)}`;
      copy.append(title, node("p", "", amount), node("time", "", `Updated ${formatDate(app.updated_at || app.created_at, true)}`));
      row.append(copy, statusPill(app.status));
      target.append(row);
    }
    const note = node("p", "", "Loan approval is not confirmation that funds have been disbursed.");
    note.className = "panel-footnote";
    target.append(note);
  }

  function renderPayoutRequests(requests) {
    const target = $("#recent-payouts-list");
    target.replaceChildren();
    if (partialErrors.has("payout requests")) {
      const empty = node("div", "empty-panel");
      empty.append(node("span", "empty-symbol", "!"), node("strong", "", "Payout requests could not be loaded"), node("p", "", "Refresh the dashboard to try again. No payment status has been inferred."));
      target.append(empty);
      return;
    }
    if (!requests.length) {
      const empty = node("div", "empty-panel");
      empty.append(node("span", "empty-symbol", "↗"), node("strong", "", "No payout requests yet"), node("p", "", "A payout request can be started from a fully recovered and eligible recovery case."));
      const link = node("a", "", "View recovery eligibility →"); link.href = "recovery.html"; empty.append(link);
      target.append(empty);
      return;
    }
    const methodLabels = { bank_transfer: "Bank transfer", crypto: "Cryptocurrency", other: "Other method" };
    for (const payout of requests.slice(0, 4)) {
      const row = node("article", "update-row");
      row.append(node("span", "update-indicator", "↗"));
      const copy = node("div", "update-content");
      copy.append(node("strong", "", formatMoney(payout.amount, payout.currency)), node("p", "", `${methodLabels[payout.method] || "Payout method"} · ${labelForStatus(payout.status)}`), node("time", "", `Requested ${formatDate(payout.created_at, true)}`));
      row.append(copy, statusPill(payout.status));
      target.append(row);
    }
    const note = node("p", "", "A payout marked approved or processing has not necessarily been paid. Check the recorded status for the latest information.");
    note.className = "panel-footnote";
    target.append(note);
  }

  function renderPartialLoadError() {
    if (!partialErrors.size) return;
    const names = [...partialErrors];
    setGlobalMessage(`Some dashboard information could not be loaded (${names.join(", ")}). Balances and statuses are never invented; use Refresh to try again.`, "error");
  }

  async function loadDashboard() {
    if (loading || !currentUser) return;
    loading = true;
    partialErrors.clear();
    const refresh = $("#dashboard-refresh");
    if (refresh) { refresh.disabled = true; refresh.innerHTML = "<span aria-hidden=\"true\">↻</span> Refreshing…"; }
    try {
      const uid = currentUser.id;
      const results = await Promise.all([
        read("profile", client.from("profiles").select("id, full_name, identity_status, account_status, onboarding_source").eq("id", uid).maybeSingle()),
        read("claims", client.from("claims").select("id, case_reference, title, category, status, created_at, updated_at").eq("user_id", uid).order("updated_at", { ascending: false }).limit(5)),
        read("active claim count", client.from("claims").select("id", { count: "exact", head: true }).eq("user_id", uid).in("status", activeClaimStatuses)),
        read("recovery balances", client.from("claim_recovery_balances").select("recovery_account_id, claim_id, case_reference, user_id, claim_title, recoverable_amount, recovered_amount, outstanding_amount, currency, fully_recovered, payout_eligible, created_at, updated_at").eq("user_id", uid).order("updated_at", { ascending: false })),
        read("loan applications", client.from("loan_applications").select("id, application_reference, requested_amount, approved_amount, currency, status, created_at, updated_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(10)),
        read("approved loan count", client.from("loan_applications").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("status", "approved")),
        read("payout requests", client.from("payout_requests").select("id, recovery_account_id, amount, currency, method, status, created_at, updated_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(5)),
        read("active payout count", client.from("payout_requests").select("id", { count: "exact", head: true }).eq("user_id", uid).in("status", activePayoutStatuses)),
        read("notifications", client.from("user_notifications").select("id, notification_type, title, body, related_claim_id, related_loan_application_id, related_loan_withdrawal_request_id, related_payout_request_id, related_support_ticket_id, is_read, created_at").order("created_at", { ascending: false }).limit(6)),
        read("unread notifications", client.from("user_notifications").select("id", { count: "exact", head: true }).eq("is_read", false)),
        read("unread message notifications", client.from("user_notifications").select("id", { count: "exact", head: true }).eq("is_read", false).eq("notification_type", "claim_message")),
        read("active support tickets", client.from("support_tickets").select("id", { count: "exact", head: true }).eq("customer_id", uid).in("status", activeSupportStatuses)),
        read("user roles", client.from("user_roles").select("role").eq("user_id", uid))
      ]);

      const [profileResult, claimsResult, activeClaimsResult, recoveryResult, loansResult, approvedLoansResult, payoutsResult, activePayoutResult, notificationsResult, unreadResult, unreadMessagesResult, activeSupportResult, rolesResult] = results;
      currentProfile = profileResult.data || null;
      latestClaims = claimsResult.data || [];
      recoveryBalances = recoveryResult.data || [];
      latestLoans = loansResult.data || [];
      latestNotifications = notificationsResult.data || [];
      const payouts = payoutsResult.data || [];
      const activeClaimsCount = activeClaimsResult.error ? null : (activeClaimsResult.count ?? 0);
      const approvedLoansCount = approvedLoansResult.error ? null : (approvedLoansResult.count ?? 0);
      const activePayoutCount = activePayoutResult.error ? null : (activePayoutResult.count ?? 0);
      const unreadCount = unreadResult.error ? null : (unreadResult.count ?? 0);
      const unreadMessageCount = unreadMessagesResult.error ? null : (unreadMessagesResult.count ?? 0);
      const activeSupportCount = activeSupportResult.error ? null : (activeSupportResult.count ?? 0);

      setGreeting(currentProfile);
      renderIdentity(currentProfile);
      const profileMissing = profileResult.error || !currentProfile;
      if (profileMissing) partialErrors.add("profile");
      renderMetrics({
        activeClaimsCount,
        recoveryCount: recoveryResult.error ? null : recoveryBalances.length,
        approvedLoansCount,
        unreadCount
      });
      const payoutEligibleCount = recoveryBalances.filter((item) => item.payout_eligible === true).length;
      $("#metric-recovery-foot").textContent = activePayoutCount === null
        ? `${payoutEligibleCount} case${payoutEligibleCount === 1 ? "" : "s"} payout eligible`
        : `${payoutEligibleCount} eligible · ${activePayoutCount} request${activePayoutCount === 1 ? "" : "s"} in progress`;
      renderRecoverySummary(recoveryBalances);
      renderClaims(latestClaims, recoveryBalances);
      renderUpdates(latestNotifications);
      renderLoanRequests(latestLoans);
      renderPayoutRequests(payouts);
      const messageBadge = $("#nav-unread-messages");
      messageBadge.hidden = !unreadMessageCount;
      messageBadge.textContent = unreadMessageCount > 99 ? "99+" : String(unreadMessageCount || 0);

      const roles = rolesResult.data || [];
      const isAdmin = roles.some((item) => ["admin", "super_admin"].includes(item.role));
      const existingAdminLink = document.querySelector("#customer-admin-workspace-link");
      const existingIdentityAdminLink = document.querySelector("#customer-identity-admin-link");
      if (isAdmin) {
        const nav = document.querySelector(".side-nav");
        if (nav && !existingAdminLink) {
          const link = node("a", "side-nav-link", "Admin workspace ↗");
          link.id = "customer-admin-workspace-link";
          link.href = "../admin/claims.html";
          nav.append(link);
        }
        if (nav && !existingIdentityAdminLink) {
          const link = node("a", "side-nav-link", "Identity review ↗");
          link.id = "customer-identity-admin-link";
          link.href = "../admin/identity-verification.html";
          nav.append(link);
        }
      }

      const supportLink = document.querySelector('a[href="support.html"]');
      const oldSupportBadge = document.querySelector("#nav-active-support");
      if (oldSupportBadge) oldSupportBadge.remove();
      if (supportLink && activeSupportCount > 0) {
        const badge = node("span", "nav-count", activeSupportCount > 99 ? "99+" : String(activeSupportCount));
        badge.id = "nav-active-support";
        supportLink.append(badge);
      }
      renderPartialLoadError();
      if (!partialErrors.size) setGlobalMessage("");
    } catch (error) {
      console.error("Refund dashboard failed to load:", error);
      setGlobalMessage("We couldn't finish loading your dashboard. Please use Refresh to try again. Your financial balances are not estimated or fabricated.", "error");
    } finally {
      loading = false;
      $("#dashboard-loading").hidden = true;
      if (refresh) { refresh.disabled = false; refresh.innerHTML = "<span aria-hidden=\"true\">↻</span> Refresh"; }
    }
  }

  async function initialize() {
    $("#current-year").textContent = String(new Date().getFullYear());
    $("#dashboard-date").textContent = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date());
    if (!window.refundSupabaseReady || !client) {
      setGlobalMessage("Supabase is not connected. Check js/config.js and js/supabase-client.js.", "error");
      $("#dashboard-loading").hidden = true;
      return;
    }
    const { data, error } = await client.auth.getSession();
    if (error || !data?.session) {
      window.location.href = "../login.html";
      return;
    }
    currentUser = data.session.user;
    $("#sign-out-button").addEventListener("click", async () => {
      const button = $("#sign-out-button");
      button.disabled = true;
      const { error: signOutError } = await client.auth.signOut();
      if (signOutError) {
        button.disabled = false;
        setGlobalMessage("We couldn't sign you out right now. Please try again.", "error");
        console.error("Refund sign out failed:", signOutError.message);
        return;
      }
      window.location.href = "../login.html";
    });
    $("#dashboard-refresh").addEventListener("click", loadDashboard);
    const menuButton = $("#mobile-menu-button");
    menuButton?.addEventListener("click", () => {
      const sidebar = $("#dashboard-sidebar");
      const open = sidebar.classList.toggle("is-open");
      menuButton.setAttribute("aria-expanded", String(open));
      menuButton.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
      menuButton.textContent = open ? "×" : "☰";
    });
    await loadDashboard();
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
