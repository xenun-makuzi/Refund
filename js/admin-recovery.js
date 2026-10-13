(() => {
  "use strict";

  const client = window.refundSupabase;
  const $ = (selector) => document.querySelector(selector);
  const el = {
    globalMessage: $("#global-message"), userName: $("#admin-user-name"), userRole: $("#admin-user-role"), signOut: $("#sign-out-button"), refresh: $("#refresh-button"),
    metricClaims: $("#metric-claims"), metricAccounts: $("#metric-accounts"), metricFull: $("#metric-full"), metricPayouts: $("#metric-payouts"),
    search: $("#claim-search"), filter: $("#recovery-filter"), claimsBody: $("#claims-table-body"), claimsCount: $("#claims-count"), claimsEmpty: $("#claims-empty"), clearFilters: $("#clear-filters"),
    detail: $("#recovery-detail"), detailMessage: $("#detail-message"), detailHeading: $("#detail-heading"), detailReference: $("#detail-reference"), closeDetail: $("#close-detail-button"),
    accountState: $("#account-state"), targetForm: $("#target-form"), targetAmount: $("#target-amount"), targetCurrency: $("#target-currency"), targetReason: $("#target-reason"), saveTarget: $("#save-target-button"),
    installmentCard: $("#installment-card"), installmentForm: $("#installment-form"), installmentAmount: $("#installment-amount"), installmentDate: $("#installment-date"), installmentReference: $("#installment-reference"), installmentNote: $("#installment-note"), recordInstallment: $("#record-installment-button"), ledgerList: $("#ledger-entry-list"), ledgerCount: $("#ledger-entry-count"),
    detailRecovered: $("#detail-recovered"), progress: $("#balance-progress"), progressLabel: $("#detail-progress-label"), progressPercent: $("#detail-progress-percent"), detailTarget: $("#detail-target"), detailOutstanding: $("#detail-outstanding"), payoutEligibility: $("#detail-payout-eligibility"), detailClaimTitle: $("#detail-claim-title"), detailClaimant: $("#detail-claimant"), detailClaimStatus: $("#detail-claim-status"), detailRequestedAmount: $("#detail-requested-amount"), detailClaimCurrency: $("#detail-claim-currency"),
    payoutsList: $("#payouts-list"), payoutsCount: $("#payouts-count"), payoutsEmpty: $("#payouts-empty")
  };

  const claimStatusLabels = {
    submitted: "Submitted", under_review: "Under review", awaiting_information: "Awaiting information",
    investigation_in_progress: "Investigation in progress", recovery_in_progress: "Recovery in progress",
    partially_recovered: "Partially recovered", recovery_complete: "Recovery complete", not_eligible: "Not eligible", closed: "Closed"
  };
  const categoryLabels = { purchase_refund: "Purchase refund", scam_recovery: "Scam recovery", tax_refund: "Tax refund", service_dispute: "Service dispute", other: "Other" };
  const payoutStatusLabels = { requested: "Requested", approved: "Approved", denied: "Denied", processing: "Processing", paid: "Paid", failed: "Failed" };
  const payoutMethodLabels = { bank_transfer: "Bank transfer", crypto: "Crypto", other: "Other" };
  const activePayoutStatuses = new Set(["requested", "approved", "processing", "paid"]);
  const openPayoutStatuses = new Set(["requested", "approved", "processing"]);

  let currentUser = null;
  let currentRole = null;
  let claims = [];
  let profiles = new Map();
  let accounts = new Map();
  let balances = new Map();
  let payouts = [];
  let selectedClaim = null;

  function textNode(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }

  function message(node, text, type = "info") {
    if (!node) return;
    node.hidden = false;
    node.className = `${node === el.globalMessage ? "page-message" : "inline-message"}${type === "error" ? " is-error" : type === "success" ? " is-success" : type === "warning" ? " is-warning" : ""}`;
    node.textContent = text;
  }

  function clearMessage(node) {
    if (!node) return;
    node.hidden = true;
    node.textContent = "";
    node.className = node === el.globalMessage ? "page-message" : "inline-message";
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent.trim();
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    button.textContent = busy ? busyText : button.dataset.originalText;
  }

  function formatDate(value, withTime = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(date);
  }

  function formatMoney(value, currency = "USD") {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "—";
    const code = String(currency || "USD").trim().toUpperCase();
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: code, maximumFractionDigits: 2 }).format(amount); }
    catch { return `${code} ${amount.toFixed(2)}`; }
  }

  function titleCase(value) {
    return String(value || "—").replaceAll("_", " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  function sourceLabel(claim) {
    const name = profiles.get(claim.user_id)?.full_name || "Customer";
    return name;
  }

  function getBalance(claimId) { return balances.get(claimId) || null; }
  function getAccount(claimId) { return accounts.get(claimId) || null; }

  function visibleClaims() {
    const term = (el.search?.value || "").trim().toLowerCase();
    const filter = el.filter?.value || "all";
    return claims.filter((claim) => {
      const balance = getBalance(claim.id);
      const account = getAccount(claim.id);
      if (filter === "not_configured" && account) return false;
      if (filter === "in_progress" && (!account || balance?.fully_recovered)) return false;
      if (filter === "fully_recovered" && !balance?.fully_recovered) return false;
      if (term) {
        const haystack = [claim.case_reference, claim.title, claim.merchant_name, sourceLabel(claim), claim.status, categoryLabels[claim.category]].join(" ").toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }

  function renderMetrics() {
    el.metricClaims.textContent = String(claims.length);
    el.metricAccounts.textContent = String(accounts.size);
    el.metricFull.textContent = String(Array.from(balances.values()).filter((item) => item.fully_recovered).length);
    el.metricPayouts.textContent = String(payouts.filter((item) => openPayoutStatuses.has(item.status)).length);
  }

  function renderClaims() {
    const list = visibleClaims();
    el.claimsBody.replaceChildren();
    el.claimsCount.textContent = `${list.length} ${list.length === 1 ? "claim" : "claims"}`;
    el.claimsEmpty.hidden = list.length > 0;
    if (!list.length) {
      const row = document.createElement("tr");
      const cell = textNode("td", "table-placeholder", claims.length ? "No claims match your filters." : "No claims have been submitted yet.");
      cell.colSpan = 7; row.append(cell); el.claimsBody.append(row);
      return;
    }

    for (const claim of list) {
      const balance = getBalance(claim.id);
      const account = getAccount(claim.id);
      const row = document.createElement("tr");
      if (selectedClaim?.id === claim.id) row.classList.add("selected-row");
      const claimCell = document.createElement("td");
      const identity = textNode("div", "claim-id-cell");
      identity.append(textNode("strong", "", claim.case_reference), textNode("span", "", claim.title), textNode("span", "table-sub", sourceLabel(claim)));
      claimCell.append(identity);
      const statusCell = textNode("td", "", claimStatusLabels[claim.status] || titleCase(claim.status));
      const targetCell = textNode("td", "", account ? formatMoney(account.target_amount, account.currency) : "Not set");
      const recoveredCell = textNode("td", "", balance ? formatMoney(balance.recovered_amount, balance.currency) : "—");
      const outstandingCell = textNode("td", "", balance ? formatMoney(balance.outstanding_amount, balance.currency) : "—");
      const stateCell = document.createElement("td");
      const state = !account ? "Target not set" : balance?.fully_recovered ? "Fully recovered" : "In progress";
      const pill = textNode("span", `state-pill ${!account ? "state-unconfigured" : balance?.fully_recovered ? "state-complete" : "state-in-progress"}`, state);
      stateCell.append(pill);
      const actionCell = document.createElement("td");
      const action = textNode("button", "row-action", selectedClaim?.id === claim.id ? "Selected" : "Manage →");
      action.type = "button";
      action.addEventListener("click", () => openClaim(claim));
      actionCell.append(action);
      row.append(claimCell, statusCell, targetCell, recoveredCell, outstandingCell, stateCell, actionCell);
      el.claimsBody.append(row);
    }
  }

  function updateDetailBalance(balance, account) {
    const currency = balance?.currency || account?.currency || selectedClaim?.currency || "USD";
    const target = Number(balance?.recoverable_amount ?? account?.target_amount ?? 0);
    const recovered = Number(balance?.recovered_amount ?? 0);
    const outstanding = Number(balance?.outstanding_amount ?? Math.max(target - recovered, 0));
    const percent = target > 0 ? Math.min(100, Math.max(0, recovered / target * 100)) : 0;
    el.detailTarget.textContent = account ? formatMoney(target, currency) : "Not configured";
    el.detailRecovered.textContent = formatMoney(recovered, currency);
    el.detailOutstanding.textContent = account ? formatMoney(outstanding, currency) : "—";
    el.progress.style.width = `${percent}%`;
    el.progressLabel.textContent = account ? `${formatMoney(recovered, currency)} of ${formatMoney(target, currency)}` : "Set a target to begin tracking";
    el.progressPercent.textContent = account ? `${Math.round(percent)}%` : "—";
    el.payoutEligibility.textContent = balance?.payout_eligible ? "Eligible" : balance?.fully_recovered ? "Checks required" : "Not eligible yet";
    el.payoutEligibility.style.color = balance?.payout_eligible ? "var(--mint)" : "var(--amber)";
    el.accountState.textContent = !account ? "Not configured" : balance?.fully_recovered ? "Fully recovered" : "In progress";
    el.accountState.className = `state-pill ${!account ? "state-unconfigured" : balance?.fully_recovered ? "state-complete" : "state-in-progress"}`;
  }

  function openClaim(claim) {
    selectedClaim = claim;
    const account = getAccount(claim.id);
    const balance = getBalance(claim.id);
    el.detail.hidden = false;
    el.detailHeading.textContent = claim.title;
    el.detailReference.textContent = `${claim.case_reference} · ${categoryLabels[claim.category] || titleCase(claim.category)}`;
    el.detailClaimTitle.textContent = claim.title;
    el.detailClaimant.textContent = sourceLabel(claim);
    el.detailClaimStatus.textContent = claimStatusLabels[claim.status] || titleCase(claim.status);
    el.detailRequestedAmount.textContent = claim.requested_amount == null ? "Not provided" : formatMoney(claim.requested_amount, claim.currency);
    el.detailClaimCurrency.textContent = String(claim.currency || "USD").trim();
    el.targetCurrency.textContent = String(claim.currency || "USD").trim();
    el.targetAmount.value = account ? Number(account.target_amount).toFixed(2) : "";
    el.targetReason.value = "";
    el.saveTarget.textContent = account ? "Update recovery target" : "Save recovery target";
    el.installmentForm.reset();
    setDefaultDate();
    el.installmentCard.hidden = !account;
    clearMessage(el.detailMessage);
    updateDetailBalance(balance, account);
    renderClaims();
    loadLedgerEntries(account).catch((error) => {
      el.ledgerList.replaceChildren(textNode("p", "muted-copy", `Could not load ledger history: ${error.message}`));
    });
    el.detail.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function setDefaultDate() {
    if (!el.installmentDate) return;
    const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    el.installmentDate.value = local.toISOString().slice(0, 16);
  }

  async function loadLedgerEntries(account) {
    el.ledgerList.replaceChildren();
    if (!account) {
      el.ledgerCount.textContent = "0 entries";
      el.ledgerList.append(textNode("p", "muted-copy", "Save a recovery target before recording installments."));
      return;
    }
    el.ledgerList.append(textNode("p", "muted-copy", "Loading ledger history…"));
    const { data, error } = await client.from("recovery_ledger_entries")
      .select("id, entry_type, amount, currency, source_reference, received_at, created_by, note, reverses_entry_id, created_at")
      .eq("recovery_account_id", account.id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    el.ledgerList.replaceChildren();
    el.ledgerCount.textContent = `${(data || []).length} ${(data || []).length === 1 ? "entry" : "entries"}`;
    if (!data?.length) {
      el.ledgerList.append(textNode("p", "muted-copy", "No installments recorded yet."));
      return;
    }
    for (const entry of data) {
      const card = textNode("article", "ledger-entry");
      const main = textNode("div", "ledger-entry-main");
      main.append(
        textNode("strong", "", entry.entry_type === "reversal" ? "Reversal" : "Recovery installment"),
        textNode("span", "", `${formatDate(entry.received_at, true)}${entry.source_reference ? ` · Ref ${entry.source_reference}` : ""}`)
      );
      const amount = textNode("strong", `ledger-entry-amount${Number(entry.amount) < 0 ? " is-negative" : ""}`, formatMoney(entry.amount, entry.currency));
      card.append(main, amount);
      if (entry.note) card.append(textNode("p", "ledger-entry-note", entry.note));
      if (entry.reverses_entry_id) card.append(textNode("p", "ledger-entry-note", "This is an audited reversal of a prior entry."));
      if (entry.entry_type === "recovery_received" && !entry.reverses_entry_id) {
        const actions = textNode("div", "ledger-entry-actions");
        const reverseButton = textNode("button", "ledger-reverse-button", "Reverse entry");
        reverseButton.type = "button";
        reverseButton.addEventListener("click", () => reverseInstallment(entry, reverseButton));
        actions.append(reverseButton);
        card.append(actions);
      }
      el.ledgerList.append(card);
    }
  }

  function maskDestination(value) {
    const text = String(value ?? "");
    if (text.length <= 4) return "••••";
    return `${"•".repeat(Math.min(10, Math.max(4, text.length - 4)))}${text.slice(-4)}`;
  }

  function allowedDestinationPairs(method, dest) {
    const candidates = method === "bank_transfer"
      ? [["Bank", "bank_name"], ["Account holder", "account_holder"], ["Account number", "account_number"], ["IBAN", "iban"], ["Country", "country"], ["Routing / SWIFT", "routing_number"], ["SWIFT / BIC", "swift_bic"]]
      : method === "crypto"
        ? [["Asset", "asset"], ["Network", "network"], ["Wallet address", "wallet_address"]]
        : [["Provider", "provider"], ["Destination", "destination"]];
    return candidates.filter(([, key]) => dest && dest[key] !== undefined && dest[key] !== null && String(dest[key]).trim() !== "");
  }

  function renderPayouts() {
    el.payoutsList.replaceChildren();
    el.payoutsCount.textContent = `${payouts.length} ${payouts.length === 1 ? "request" : "requests"}`;
    el.payoutsEmpty.hidden = payouts.length > 0;
    if (!payouts.length) return;
    const displayList = payouts.slice();
    for (const payout of displayList) {
      const card = textNode("article", "payout-card");
      const top = textNode("div", "payout-head");
      const topLeft = textNode("div", "payout-head-left");
      const account = Array.from(accounts.values()).find((item) => item.id === payout.recovery_account_id);
      const claim = account ? claims.find((item) => item.id === account.claim_id) : null;
      const claimantName = profiles.get(payout.user_id)?.full_name || "Customer";
      topLeft.append(
        textNode("strong", "", `${claim?.case_reference || "Recovery payout"} · ${claimantName}`),
        textNode("span", "", `Request ${payout.id} · Submitted ${formatDate(payout.created_at, true)}`)
      );
      const statusAndAmount = textNode("div", "");
      statusAndAmount.style.display = "grid";
      statusAndAmount.style.gap = "8px";
      statusAndAmount.style.justifyItems = "end";
      const status = textNode("span", `payout-status ${payout.status}`, payoutStatusLabels[payout.status] || titleCase(payout.status));
      const amount = textNode("strong", "payout-amount", formatMoney(payout.amount, payout.currency));
      statusAndAmount.append(amount, status);
      top.append(topLeft, statusAndAmount);
      card.append(top);

      const chips = textNode("div", "payout-metadata");
      chips.append(
        textNode("span", "meta-chip", payoutMethodLabels[payout.method] || titleCase(payout.method)),
        textNode("span", "meta-chip", claim?.title || "Claim unavailable"),
        textNode("span", "meta-chip", `Updated ${formatDate(payout.updated_at || payout.created_at)}`)
      );
      card.append(chips);

      const detailsWrap = textNode("div", "payout-details");
      const details = document.createElement("details");
      details.append(textNode("summary", "", "View payout destination (sensitive information)"));
      const destGrid = textNode("div", "destination-grid");
      const pairs = allowedDestinationPairs(payout.method, payout.destination_details || {});
      for (const [label, key] of pairs) {
        const field = textNode("div", "destination-field");
        field.append(textNode("span", "", label));
        const sensitive = ["account_number", "iban", "wallet_address", "destination", "routing_number", "swift_bic"].includes(key);
        const shown = textNode("strong", "", sensitive ? maskDestination(payout.destination_details[key]) : payout.destination_details[key]);
        field.append(shown);
        if (sensitive) {
          const reveal = textNode("button", "text-button", "Reveal");
          reveal.type = "button";
          reveal.setAttribute("aria-label", `Reveal ${label}`);
          let revealed = false;
          reveal.addEventListener("click", () => {
            revealed = !revealed;
            shown.textContent = revealed ? String(payout.destination_details[key]) : maskDestination(payout.destination_details[key]);
            reveal.textContent = revealed ? "Hide" : "Reveal";
          });
          field.append(reveal);
        }
        destGrid.append(field);
      }
      if (!pairs.length) destGrid.append(textNode("p", "muted-copy", "No recognized destination details were supplied."));
      details.append(destGrid);
      detailsWrap.append(details);
      card.append(detailsWrap);

      if (payout.decision_reason) card.append(textNode("p", "payout-history-note", `Admin note: ${payout.decision_reason}`));
      if (payout.provider_reference) card.append(textNode("p", "payout-history-note", `Payment reference: ${payout.provider_reference}`));

      if (payout.status === "requested" || payout.status === "approved" || payout.status === "processing") {
        const tools = textNode("div", "payout-review-tools");
        const noteWrap = textNode("div", "payout-note-field");
        noteWrap.append(textNode("label", "", payout.status === "requested" ? "Review note (required to deny)" : payout.status === "processing" ? "Payment / processing note" : "Decision note (required to deny)"));
        const noteInput = document.createElement("textarea");
        noteInput.rows = 2; noteInput.maxLength = 2000;
        noteInput.placeholder = payout.status === "requested" ? "Reason for denial, if applicable…" : "Optional note for the audit trail…";
        noteWrap.append(noteInput);
        tools.append(noteWrap);

        const secondWrap = textNode("div", "payout-note-field");
        if (payout.status === "processing") {
          secondWrap.append(textNode("label", "", "Verified transaction reference (required to mark paid)"));
          const referenceInput = document.createElement("input");
          referenceInput.type = "text"; referenceInput.maxLength = 200; referenceInput.placeholder = "Confirmed transfer reference";
          secondWrap.append(referenceInput);
          tools.append(secondWrap);
        } else {
          secondWrap.append(textNode("label", "", "Actions"));
          const actions = textNode("div", "payout-actions");
          secondWrap.append(actions);
          tools.append(secondWrap);
          const validNext = payout.status === "requested" ? ["approved", "denied"] : ["processing", "denied"];
          for (const nextStatus of validNext) {
            const button = textNode("button", "payout-action-button", titleCase(nextStatus));
            button.type = "button"; button.dataset.action = nextStatus;
            button.addEventListener("click", () => updatePayout(payout, nextStatus, noteInput.value.trim(), null, button));
            actions.append(button);
          }
        }
        if (payout.status === "processing") {
          const actions = textNode("div", "payout-actions");
          for (const nextStatus of ["paid", "failed"]) {
            const button = textNode("button", "payout-action-button", titleCase(nextStatus));
            button.type = "button"; button.dataset.action = nextStatus;
            button.addEventListener("click", () => updatePayout(payout, nextStatus, noteInput.value.trim(), secondWrap.querySelector("input")?.value.trim() || null, button));
            actions.append(button);
          }
          secondWrap.append(actions);
        }
        card.append(tools);
      }
      el.payoutsList.append(card);
    }
  }

  async function updatePayout(payout, nextStatus, note, providerReference, button) {
    if (nextStatus === "denied" && note.length < 3) {
      message(el.globalMessage, "A reason of at least 3 characters is required to deny a payout.", "warning");
      return;
    }
    if (nextStatus === "paid" && (!providerReference || providerReference.length < 3)) {
      message(el.globalMessage, "Enter the verified transaction reference before marking this payout as paid.", "warning");
      return;
    }
    const confirmation = nextStatus === "paid"
      ? "Confirm the payout has actually been sent and independently verified. This action records the request as paid; it does not send money. Continue?"
      : `Change payout status to ${nextStatus.replaceAll("_", " ")}?`;
    if (!window.confirm(confirmation)) return;
    setBusy(button, true, "Saving…");
    clearMessage(el.globalMessage);
    try {
      const { error } = await client.rpc("admin_update_payout_status", {
        p_payout_request_id: payout.id,
        p_new_status: nextStatus,
        p_note: note || null,
        p_provider_reference: providerReference || null
      });
      if (error) throw error;
      message(el.globalMessage, `Payout status updated to ${payoutStatusLabels[nextStatus] || titleCase(nextStatus)}.`, "success");
      await loadAllData();
    } catch (error) {
      console.error("Payout status update failed:", error.message || error);
      message(el.globalMessage, `Could not update payout. ${error.message || "Check administrator permissions and try again."}`, "error");
      setBusy(button, false);
    }
  }

  async function reverseInstallment(entry, button) {
    const approved = window.confirm("This will add a matching negative ledger entry; it will not delete the original record. Continue only if the installment was recorded incorrectly or needs a formal reversal.");
    if (!approved) return;
    const reason = window.prompt("Enter the reason for this audited reversal (at least 3 characters):", "");
    if (reason === null) return;
    if (reason.trim().length < 3) {
      message(el.detailMessage, "A reversal reason of at least 3 characters is required.", "warning");
      return;
    }
    setBusy(button, true, "Reversing…");
    try {
      const { error } = await client.rpc("reverse_recovery_installment", {
        p_entry_id: entry.id,
        p_reason: reason.trim()
      });
      if (error) throw error;
      message(el.detailMessage, "Reversal recorded. The original ledger entry remains in the audit history.", "success");
      await loadAllData();
    } catch (error) {
      console.error("Recovery installment reversal failed:", error.message || error);
      message(el.detailMessage, `Could not reverse this entry. ${error.message || "Check the entry and payout status."}`, "error");
      setBusy(button, false);
    }
  }

  async function loadAllData() {
    if (!currentUser) return;
    setBusy(el.refresh, true, "Refreshing…");
    clearMessage(el.globalMessage);
    try {
      const [claimRes, balanceRes, accountRes, payoutRes] = await Promise.all([
        client.from("claims").select("id, case_reference, user_id, category, title, merchant_name, requested_amount, currency, status, created_at").order("created_at", { ascending: false }).limit(500),
        client.from("claim_recovery_balances").select("recovery_account_id, claim_id, case_reference, user_id, claim_title, recoverable_amount, recovered_amount, outstanding_amount, currency, fully_recovered, payout_eligible, created_at, updated_at").limit(1000),
        client.from("claim_recovery_accounts").select("id, claim_id, target_amount, currency, created_at, updated_at").limit(1000),
        client.from("payout_requests").select("id, recovery_account_id, user_id, amount, currency, method, destination_details, status, decision_reason, provider_reference, reviewed_at, paid_at, created_at, updated_at").order("created_at", { ascending: false }).limit(500)
      ]);
      const failure = [claimRes, balanceRes, accountRes, payoutRes].find((result) => result.error);
      if (failure?.error) throw failure.error;

      claims = claimRes.data || [];
      balances = new Map((balanceRes.data || []).map((item) => [item.claim_id, item]));
      accounts = new Map((accountRes.data || []).map((item) => [item.claim_id, item]));
      payouts = payoutRes.data || [];

      const userIds = [...new Set([...claims.map((claim) => claim.user_id), ...payouts.map((payout) => payout.user_id)].filter(Boolean))];
      profiles = new Map();
      if (userIds.length) {
        const { data: profileData, error: profileError } = await client.from("profiles").select("id, full_name").in("id", userIds);
        if (profileError) throw profileError;
        profiles = new Map((profileData || []).map((profile) => [profile.id, profile]));
      }

      renderMetrics();
      renderClaims();
      renderPayouts();
      if (selectedClaim) {
        const latest = claims.find((claim) => claim.id === selectedClaim.id);
        if (latest) {
          selectedClaim = latest;
          const account = getAccount(latest.id);
          updateDetailBalance(getBalance(latest.id), account);
          el.targetAmount.value = account ? Number(account.target_amount).toFixed(2) : "";
          el.targetCurrency.textContent = String(latest.currency || "USD").trim();
          el.saveTarget.textContent = account ? "Update recovery target" : "Save recovery target";
          el.installmentCard.hidden = !account;
          await loadLedgerEntries(account);
        }
      }
    } catch (error) {
      console.error("Recovery workspace load failed:", error.message || error);
      message(el.globalMessage, `Could not load recovery data. ${error.message || "Check migrations and database permissions."}`, "error");
      el.claimsBody.replaceChildren();
      const row = document.createElement("tr"); const cell = textNode("td", "table-placeholder", "Data could not be loaded."); cell.colSpan = 7; row.append(cell); el.claimsBody.append(row);
      el.payoutsList.replaceChildren(textNode("p", "table-placeholder", "Payout requests could not be loaded."));
    } finally {
      setBusy(el.refresh, false);
    }
  }

  async function saveTarget(event) {
    event.preventDefault();
    if (!selectedClaim) return message(el.detailMessage, "Select a claim first.", "warning");
    clearMessage(el.detailMessage);
    const amount = Number(el.targetAmount.value);
    const reason = el.targetReason.value.trim();
    if (!Number.isFinite(amount) || amount <= 0) return message(el.detailMessage, "Enter a valid target amount greater than zero.", "error");
    if (reason.length < 3) return message(el.detailMessage, "Add a reason of at least 3 characters for the audit history.", "error");
    setBusy(el.saveTarget, true, "Saving target…");
    try {
      const { data, error } = await client.rpc("configure_claim_recovery", {
        p_claim_id: selectedClaim.id,
        p_target_amount: amount.toFixed(2),
        p_reason: reason
      });
      if (error) throw error;
      message(el.detailMessage, "Recovery target saved and audit history recorded.", "success");
      await loadAllData();
      const latest = claims.find((claim) => claim.id === selectedClaim?.id);
      if (latest) {
        selectedClaim = latest;
        updateDetailBalance(getBalance(latest.id), getAccount(latest.id));
        el.installmentCard.hidden = !getAccount(latest.id);
      }
      el.targetReason.value = "";
      if (data) el.targetAmount.dataset.accountId = String(data);
    } catch (error) {
      console.error("Configure recovery target failed:", error.message || error);
      message(el.detailMessage, `Could not save recovery target. ${error.message || "Check the database function and permissions."}`, "error");
    } finally {
      setBusy(el.saveTarget, false);
    }
  }

  async function recordInstallment(event) {
    event.preventDefault();
    if (!selectedClaim) return message(el.detailMessage, "Select a claim first.", "warning");
    const account = getAccount(selectedClaim.id);
    if (!account) return message(el.detailMessage, "Set a recovery target before recording an installment.", "warning");
    const amount = Number(el.installmentAmount.value);
    if (!Number.isFinite(amount) || amount <= 0) return message(el.detailMessage, "Enter an installment amount greater than zero.", "error");
    if (el.installmentDate.value === "") return message(el.detailMessage, "Choose when the funds were received.", "error");
    const receivedAt = new Date(el.installmentDate.value);
    if (Number.isNaN(receivedAt.getTime())) return message(el.detailMessage, "The received date is invalid.", "error");
    setBusy(el.recordInstallment, true, "Recording installment…");
    try {
      const { error } = await client.rpc("record_recovery_installment", {
        p_recovery_account_id: account.id,
        p_amount: amount.toFixed(2),
        p_received_at: receivedAt.toISOString(),
        p_source_reference: el.installmentReference.value.trim() || null,
        p_note: el.installmentNote.value.trim() || null
      });
      if (error) throw error;
      message(el.detailMessage, "Verified installment recorded in the append-only ledger.", "success");
      el.installmentAmount.value = "";
      el.installmentReference.value = "";
      el.installmentNote.value = "";
      setDefaultDate();
      await loadAllData();
    } catch (error) {
      console.error("Record recovery installment failed:", error.message || error);
      message(el.detailMessage, `Could not record installment. ${error.message || "Check amount, source reference, and remaining target."}`, "error");
    } finally {
      setBusy(el.recordInstallment, false);
    }
  }

  async function checkAdmin() {
    if (!window.refundSupabaseReady || !client) {
      message(el.globalMessage, "Supabase client is unavailable. Check js/config.js and js/supabase-client.js, then reload.", "error");
      return false;
    }
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    const session = sessionData?.session;
    if (!session?.user) {
      window.location.replace("../login.html?next=admin/recovery.html");
      return false;
    }
    currentUser = session.user;
    const { data: roleRows, error: roleError } = await client.from("user_roles").select("role").eq("user_id", currentUser.id);
    if (roleError) throw roleError;
    const roles = (roleRows || []).map((item) => item.role);
    currentRole = roles.includes("super_admin") ? "super_admin" : roles.includes("admin") ? "admin" : null;
    if (!currentRole) {
      message(el.globalMessage, "Access denied. This workspace is restricted to administrators.", "error");
      el.userName.textContent = currentUser.email || "Signed-in user";
      el.userRole.textContent = "No administrator role";
      return false;
    }
    el.userName.textContent = currentUser.email || "Administrator";
    el.userRole.textContent = currentRole === "super_admin" ? "Super administrator" : "Administrator";
    return true;
  }

  function wireEvents() {
    el.refresh?.addEventListener("click", () => loadAllData());
    el.search?.addEventListener("input", renderClaims);
    el.filter?.addEventListener("change", renderClaims);
    el.clearFilters?.addEventListener("click", () => { el.search.value = ""; el.filter.value = "all"; renderClaims(); });
    el.closeDetail?.addEventListener("click", () => { el.detail.hidden = true; selectedClaim = null; renderClaims(); });
    el.targetForm?.addEventListener("submit", saveTarget);
    el.installmentForm?.addEventListener("submit", recordInstallment);
    el.signOut?.addEventListener("click", async () => {
      setBusy(el.signOut, true, "Signing out…");
      try { await client.auth.signOut(); } finally { window.location.assign("../login.html"); }
    });
    client?.auth?.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") window.location.replace("../login.html");
    });
  }

  async function init() {
    if (el.installmentDate) setDefaultDate();
    wireEvents();
    try {
      const allowed = await checkAdmin();
      if (allowed) await loadAllData();
    } catch (error) {
      console.error("Recovery admin initialization failed:", error.message || error);
      message(el.globalMessage, `Could not verify administrator access. ${error.message || "Reload and try again."}`, "error");
    }
  }

  init();
})();
