(() => {
  "use strict";

  const client = window.refundSupabase;
  const $ = (selector) => document.querySelector(selector);
  const el = {
    email: $("#recovery-user-email"), signOut: $("#recovery-sign-out"), refresh: $("#recovery-refresh"),
    message: $("#recovery-global-message"), summary: $("#recovery-summary-grid"), cases: $("#recovery-cases-list"),
    caseCount: $("#recovery-case-count"), payouts: $("#payout-history-list"), identityTitle: $("#identity-title"),
    identityDescription: $("#identity-description"), identityPill: $("#identity-pill"), year: $("#current-year"),
    dialog: $("#payout-dialog"), form: $("#payout-form"), formMessage: $("#payout-form-message"),
    dialogSubtitle: $("#payout-dialog-subtitle"), requestAmount: $("#payout-request-amount"), accountId: $("#payout-recovery-account-id"),
    method: $("#payout-method"), bankFields: $("#bank-fields"), cryptoFields: $("#crypto-fields"), otherFields: $("#other-fields"),
    closeX: $("#payout-close-x"), cancel: $("#payout-cancel"), submit: $("#payout-submit")
  };

  const activePayoutStatuses = new Set(["requested", "approved", "processing", "paid"]);
  const inProgressPayoutStatuses = new Set(["requested", "approved", "processing"]);
  const claimStatusLabels = {
    submitted: "Submitted", under_review: "Under review", awaiting_information: "Awaiting information",
    investigation_in_progress: "Investigation in progress", recovery_in_progress: "Recovery in progress",
    partially_recovered: "Partially recovered", recovery_complete: "Recovery complete",
    not_eligible: "Not eligible", closed: "Closed"
  };
  const payoutStatusLabels = {
    requested: "Awaiting review", approved: "Approved", denied: "Denied", processing: "Processing",
    paid: "Paid", failed: "Failed"
  };
  const payoutMethodLabels = { bank_transfer: "Bank transfer", crypto: "Cryptocurrency", other: "Other method" };

  let currentUser = null;
  let currentProfile = null;
  let recoveryAccounts = [];
  let claimsById = new Map();
  let payoutRequests = [];
  let activeRecoveryAccount = null;
  let loading = false;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function showMessage(node, text, kind = "info") {
    if (!node) return;
    node.hidden = false;
    node.className = `cr-message${kind === "error" ? " is-error" : kind === "success" ? " is-success" : kind === "warning" ? " is-warning" : ""}`;
    node.textContent = text;
  }

  function clearMessage(node) {
    if (!node) return;
    node.hidden = true;
    node.textContent = "";
    node.className = "cr-message";
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

  function formatDate(value, withTime = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, withTime
      ? { dateStyle: "medium", timeStyle: "short" }
      : { dateStyle: "medium" }).format(date);
  }

  function titleCase(value) {
    return String(value || "Unknown").replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function getClaim(balance) {
    return claimsById.get(balance.claim_id) || null;
  }

  function payoutsForAccount(accountId) {
    return payoutRequests.filter((payout) => payout.recovery_account_id === accountId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  function activePayoutForAccount(accountId) {
    return payoutsForAccount(accountId).find((payout) => activePayoutStatuses.has(payout.status)) || null;
  }

  function remainingRatio(balance) {
    const target = Number(balance.recoverable_amount) || 0;
    const recovered = Number(balance.recovered_amount) || 0;
    return target > 0 ? Math.min(100, Math.max(0, (recovered / target) * 100)) : 0;
  }

  function setIdentityStrip(profile) {
    const status = profile?.identity_status || "unsubmitted";
    const accountStatus = profile?.account_status || "active";
    const labels = {
      verified: ["Identity verified", "Your identity is marked as verified. Payout requests also require full recovery and an active account."],
      pending: ["Identity review in progress", "Payout requests remain unavailable until the identity review is complete."],
      rejected: ["Identity verification needs attention", "Follow the team's instructions to resolve your verification status before requesting a payout."],
      action_required: ["More identity information needed", "Provide the additional information requested by the team before a payout can be submitted."],
      unsubmitted: ["Identity verification not completed", "Payout requests require a verified identity. You can still view your recovery records here."]
    };
    const entry = labels[status] || labels.unsubmitted;
    el.identityTitle.textContent = accountStatus !== "active" ? "Account access is restricted" : entry[0];
    el.identityDescription.textContent = accountStatus !== "active"
      ? "Payout requests are unavailable while the account is not active. Contact support if you need help."
      : entry[1];
    el.identityPill.textContent = accountStatus !== "active" ? titleCase(accountStatus) : titleCase(status);
    el.identityPill.className = `cr-identity-pill${status === "verified" && accountStatus === "active" ? " is-verified" : status === "rejected" || accountStatus !== "active" ? " is-rejected" : " is-pending"}`;
  }

  function renderSummary() {
    const byCurrency = new Map();
    for (const balance of recoveryAccounts) {
      const currency = String(balance.currency || "USD").trim().toUpperCase();
      if (!byCurrency.has(currency)) byCurrency.set(currency, { currency, recoverable: 0, recovered: 0, outstanding: 0, count: 0, full: 0 });
      const summary = byCurrency.get(currency);
      summary.recoverable += Number(balance.recoverable_amount) || 0;
      summary.recovered += Number(balance.recovered_amount) || 0;
      summary.outstanding += Number(balance.outstanding_amount) || 0;
      summary.count += 1;
      if (balance.fully_recovered) summary.full += 1;
    }
    el.summary.replaceChildren();
    if (!byCurrency.size) {
      const card = make("article", "cr-summary-card cr-summary-empty");
      card.append(
        make("span", "cr-summary-currency", "RECOVERY SUMMARY"),
        make("div", "cr-summary-label", "No approved recovery targets yet"),
        make("div", "cr-summary-value", formatMoney(0, "USD")),
        make("p", "cr-fine-print", "Once an approved recovery target is configured for one of your claims, the verified amounts will appear here.")
      );
      el.summary.append(card);
      return;
    }

    const summaries = Array.from(byCurrency.values()).sort((a, b) => a.currency.localeCompare(b.currency));
    for (const summary of summaries) {
      const card = make("article", "cr-summary-card");
      card.append(make("span", "cr-summary-currency", summary.currency));
      card.append(make("div", "cr-summary-label", "Total approved recovery target"));
      card.append(make("div", "cr-summary-value", formatMoney(summary.recoverable, summary.currency)));
      const recoveredRow = make("div", "cr-summary-bottom");
      recoveredRow.append(make("span", "", "Recovered so far"), make("strong", "", formatMoney(summary.recovered, summary.currency)));
      card.append(recoveredRow);
      const outstandingRow = make("div", "cr-summary-bottom");
      outstandingRow.append(make("span", "", "Still outstanding"), make("strong", "", formatMoney(summary.outstanding, summary.currency)));
      card.append(outstandingRow);
      const track = make("div", "cr-progress-track");
      const fill = make("div", "cr-progress-fill");
      fill.style.width = `${summary.recoverable > 0 ? Math.min(100, Math.max(0, summary.recovered / summary.recoverable * 100)) : 0}%`;
      track.append(fill);
      card.append(track);
      const foot = make("div", "cr-summary-bottom");
      foot.append(make("span", "", `${summary.count} ${summary.count === 1 ? "recovery account" : "recovery accounts"}`), make("strong", "", `${summary.full} fully recovered`));
      card.append(foot);
      el.summary.append(card);
    }
  }

  function caseStatusClass(status) {
    if (status === "recovery_complete") return "is-complete";
    if (["not_eligible", "closed"].includes(status)) return "is-closed";
    return "is-progress";
  }

  function payoutExplanation(balance, activePayout) {
    if (activePayout) {
      if (activePayout.status === "paid") return "A payout has been recorded as paid for this recovery account. If you have questions, contact support.";
      return `A payout request is already ${payoutStatusLabels[activePayout.status]?.toLowerCase() || "active"}. You can track its status in Payout requests below.`;
    }
    if (!balance.fully_recovered) return "Payout requests open when the full approved recovery target has been recorded as recovered.";
    if (!currentProfile || currentProfile.identity_status !== "verified") return "The full target is reached, but identity verification must be completed before a payout request can be submitted.";
    if (currentProfile.account_status !== "active") return "This account is not currently eligible to request a payout. Contact support for assistance.";
    if (!balance.payout_eligible) return "Payout eligibility is not currently available. Refresh the page or contact support if this continues.";
    return "The full target is reached and the current payout checks are satisfied.";
  }

  function renderRecoveryCases() {
    el.cases.replaceChildren();
    el.caseCount.textContent = `${recoveryAccounts.length} ${recoveryAccounts.length === 1 ? "account" : "accounts"}`;
    if (!recoveryAccounts.length) {
      const empty = make("div", "cr-empty-state");
      empty.append(
        make("div", "cr-empty-icon", "◇"),
        make("h3", "", "No recovery balances to display yet"),
        make("p", "", "Your claims can be investigated before a recovery target is set. Once the team configures an approved recovery target and records verified installments, the details will appear here."),
        make("a", "cr-inline-link", "Open my claims →")
      );
      empty.querySelector("a").href = "claims.html";
      el.cases.append(empty);
      return;
    }

    for (const balance of recoveryAccounts) {
      const claim = getClaim(balance);
      const latestPayout = payoutsForAccount(balance.recovery_account_id)[0] || null;
      const activePayout = activePayoutForAccount(balance.recovery_account_id);
      const progress = remainingRatio(balance);
      const card = make("article", "cr-recovery-card");
      const head = make("div", "cr-recovery-card-head");
      const left = make("div", "cr-case-main");
      const referenceLine = make("div", "cr-case-reference");
      referenceLine.append(make("span", "", balance.case_reference || claim?.case_reference || "Recovery account"));
      const statusText = claim ? (claimStatusLabels[claim.status] || titleCase(claim.status)) : (balance.fully_recovered ? "Recovery complete" : "Recovery in progress");
      const statusPill = make("span", `cr-status-pill ${caseStatusClass(claim?.status)}`, statusText);
      referenceLine.append(statusPill);
      left.append(referenceLine);
      left.append(make("h3", "cr-case-title", balance.claim_title || claim?.title || "Recovery case"));
      left.append(make("div", "cr-case-date", `Recovery record updated ${formatDate(balance.updated_at || balance.created_at)}`));
      head.append(left);
      const recoveryPill = make("span", `cr-status-pill ${balance.fully_recovered ? "is-complete" : "is-progress"}`, balance.fully_recovered ? "Target reached" : Number(balance.recovered_amount) > 0 ? "Partially recovered" : "Awaiting recovery");
      head.append(recoveryPill);
      card.append(head);

      const body = make("div", "cr-recovery-card-body");
      const stats = make("div", "cr-case-stat-grid");
      const statData = [
        ["Total recoverable", balance.recoverable_amount, ""],
        ["Recovered so far", balance.recovered_amount, "is-green"],
        ["Outstanding", balance.outstanding_amount, ""]
      ];
      for (const [label, amount, amountClass] of statData) {
        const stat = make("div", "cr-case-stat");
        stat.append(make("span", "", label), make("strong", amountClass, formatMoney(amount, balance.currency)));
        stats.append(stat);
      }
      body.append(stats);
      const progressRow = make("div", "cr-case-progress-row");
      progressRow.append(make("span", "", "Recovery progress"), make("strong", "", `${Math.round(progress)}%`));
      body.append(progressRow);
      const track = make("div", "cr-case-progress-track");
      const fill = make("div", "cr-case-progress-fill");
      fill.style.width = `${progress}%`;
      track.append(fill);
      body.append(track);

      const actionRow = make("div", "cr-case-actions");
      actionRow.append(make("p", "cr-case-explanation", payoutExplanation(balance, activePayout || (latestPayout?.status === "paid" ? latestPayout : null))));
      const payoutCanBeRequested = Boolean(balance.payout_eligible && currentProfile?.identity_status === "verified" && currentProfile?.account_status === "active" && !activePayout);
      if (payoutCanBeRequested) {
        const button = make("button", "cr-button cr-button-primary", "Request recovered funds →");
        button.type = "button";
        button.addEventListener("click", () => openPayoutDialog(balance));
        actionRow.append(button);
      } else if (activePayout && activePayout.status !== "paid") {
        const button = make("button", "cr-button cr-button-outline", "View payout status ↓");
        button.type = "button";
        button.addEventListener("click", () => $("#payouts-title").scrollIntoView({ behavior: "smooth", block: "start" }));
        actionRow.append(button);
      } else if (!activePayout && latestPayout && ["denied", "failed"].includes(latestPayout.status) && payoutCanBeRequested) {
        const button = make("button", "cr-button cr-button-primary", "Request payout again →");
        button.type = "button";
        button.addEventListener("click", () => openPayoutDialog(balance));
        actionRow.append(button);
      }
      body.append(actionRow);
      card.append(body);
      el.cases.append(card);
    }
  }

  function payoutStatusClass(status) {
    if (status === "paid") return "is-paid";
    if (["requested", "approved", "processing"].includes(status)) return "is-active";
    if (["denied", "failed"].includes(status)) return `is-${status}`;
    return "";
  }

  function renderPayoutHistory() {
    el.payouts.replaceChildren();
    if (!payoutRequests.length) {
      const empty = make("div", "cr-empty-state");
      empty.append(
        make("div", "cr-empty-icon", "↗"),
        make("h3", "", "No payout requests yet"),
        make("p", "", "When a recovery account reaches its full approved target and required checks are complete, you can request a payout from that case.")
      );
      el.payouts.append(empty);
      return;
    }

    for (const payout of payoutRequests) {
      const row = make("article", "cr-payout-row");
      const main = make("div", "cr-payout-main");
      const balance = recoveryAccounts.find((item) => item.recovery_account_id === payout.recovery_account_id);
      const claim = balance ? getClaim(balance) : null;
      main.append(make("strong", "", `${claim?.case_reference || "Recovery payout"} · ${payoutMethodLabels[payout.method] || titleCase(payout.method)}`));
      const meta = make("div", "cr-payout-meta");
      meta.append(make("span", "", `Requested ${formatDate(payout.created_at, true)}`));
      if (payout.paid_at) meta.append(make("span", "", `Paid ${formatDate(payout.paid_at, true)}`));
      main.append(meta);
      if (payout.decision_reason && ["denied", "failed"].includes(payout.status)) {
        main.append(make("p", "cr-payout-note", payout.decision_reason));
      }
      const side = make("div", "cr-payout-side");
      side.append(make("strong", "cr-payout-amount", formatMoney(payout.amount, payout.currency)));
      side.append(make("span", `cr-payout-status ${payoutStatusClass(payout.status)}`, payoutStatusLabels[payout.status] || titleCase(payout.status)));
      row.append(main, side);
      el.payouts.append(row);
    }
  }

  function updateMethodFields() {
    const method = el.method.value;
    el.bankFields.hidden = method !== "bank_transfer";
    el.cryptoFields.hidden = method !== "crypto";
    el.otherFields.hidden = method !== "other";

    const setRequired = (selector, required) => { const field = $(selector); if (field) field.required = required; };
    setRequired("#bank-name", method === "bank_transfer");
    setRequired("#bank-account-holder", method === "bank_transfer");
    setRequired("#bank-account-number", false); // account number OR IBAN is validated below
    setRequired("#bank-iban", false);
    setRequired("#crypto-asset", method === "crypto");
    setRequired("#crypto-network", method === "crypto");
    setRequired("#crypto-address", method === "crypto");
    setRequired("#other-provider", method === "other");
    setRequired("#other-destination", method === "other");
  }

  function openPayoutDialog(balance) {
    if (!balance || !balance.payout_eligible || currentProfile?.identity_status !== "verified" || currentProfile?.account_status !== "active") {
      showMessage(el.message, "Payout eligibility is not available for this recovery account yet. Refresh the page and check your identity status.", "warning");
      return;
    }
    el.form.reset();
    activeRecoveryAccount = balance;
    el.accountId.value = balance.recovery_account_id;
    el.requestAmount.textContent = formatMoney(balance.recovered_amount, balance.currency);
    el.dialogSubtitle.textContent = `${balance.case_reference || "Recovery case"}. The full verified recovered amount will be included in the request.`;
    clearMessage(el.formMessage);
    updateMethodFields();
    if (typeof el.dialog.showModal === "function") el.dialog.showModal();
    else showMessage(el.message, "Your browser does not support the secure payout form. Update your browser and try again.", "error");
  }

  function closePayoutDialog() {
    if (el.dialog?.open) el.dialog.close();
    activeRecoveryAccount = null;
    el.form.reset();
    clearMessage(el.formMessage);
    updateMethodFields();
  }

  function collectDestinationDetails(method) {
    if (method === "bank_transfer") {
      const details = {
        bank_name: $("#bank-name").value.trim(),
        account_holder: $("#bank-account-holder").value.trim(),
        account_number: $("#bank-account-number").value.trim(),
        iban: $("#bank-iban").value.trim(),
        country: $("#bank-country").value.trim(),
        routing_number: $("#bank-routing").value.trim()
      };
      if (!details.bank_name || !details.account_holder || (!details.account_number && !details.iban)) {
        throw new Error("Enter the bank name, account holder, and either an account number or an IBAN.");
      }
      return Object.fromEntries(Object.entries(details).filter(([, value]) => value));
    }
    if (method === "crypto") {
      const details = {
        asset: $("#crypto-asset").value.trim(),
        network: $("#crypto-network").value.trim(),
        wallet_address: $("#crypto-address").value.trim()
      };
      if (!details.asset || !details.network || !details.wallet_address) throw new Error("Enter the asset, network, and destination wallet address.");
      return details;
    }
    const details = {
      provider: $("#other-provider").value.trim(),
      destination: $("#other-destination").value.trim()
    };
    if (!details.provider || !details.destination) throw new Error("Enter the payout provider and destination details.");
    return details;
  }

  async function submitPayout(event) {
    event.preventDefault();
    clearMessage(el.formMessage);
    if (!activeRecoveryAccount) {
      showMessage(el.formMessage, "Select an eligible recovery account and try again.", "error");
      return;
    }
    if (!currentUser || !window.refundSupabaseReady) {
      showMessage(el.formMessage, "Your secure session is unavailable. Sign in again and retry.", "error");
      return;
    }
    if (currentProfile?.identity_status !== "verified" || currentProfile?.account_status !== "active") {
      showMessage(el.formMessage, "Your current account or identity status does not allow payout requests.", "error");
      return;
    }

    let destinationDetails;
    try {
      destinationDetails = collectDestinationDetails(el.method.value);
    } catch (error) {
      showMessage(el.formMessage, error.message, "error");
      return;
    }

    const originalText = el.submit.textContent;
    el.submit.disabled = true;
    el.submit.setAttribute("aria-busy", "true");
    el.submit.textContent = "Submitting securely…";
    try {
      const { data, error } = await client.rpc("request_claim_payout", {
        p_recovery_account_id: activeRecoveryAccount.recovery_account_id,
        p_method: el.method.value,
        p_destination_details: destinationDetails
      });
      if (error) throw error;
      closePayoutDialog();
      showMessage(el.message, "Your payout request has been submitted for review. No funds have been transferred by this request.", "success");
      await loadData();
    } catch (error) {
      console.error("Payout request failed:", error?.message || error);
      showMessage(el.formMessage, friendlyPayoutError(error), "error");
    } finally {
      el.submit.disabled = false;
      el.submit.removeAttribute("aria-busy");
      el.submit.textContent = originalText;
    }
  }

  function friendlyPayoutError(error) {
    const text = String(error?.message || "");
    const known = [
      ["full recovery target has not been reached", "The full approved recovery target has not been reached yet."],
      ["Identity verification must be completed", "Identity verification must be completed before you can request a payout."],
      ["account is not eligible", "Your account is not currently eligible to request a payout."],
      ["payout request", "A payout request may already exist for this recovery account. Refresh the page to check its status."],
      ["bank name, account holder", "Please check the bank details. Bank name, account holder, and account number or IBAN are required."],
      ["crypto asset, network", "Please provide the cryptocurrency asset, network, and wallet address."],
      ["Only an administrator", "Your current session could not be authorized for this action. Sign in again if the problem continues."]
    ];
    const match = known.find(([needle]) => text.toLowerCase().includes(needle.toLowerCase()));
    return match ? match[1] : (text || "We couldn't submit the request. Refresh the page and try again.");
  }

  async function loadData() {
    if (loading) return;
    loading = true;
    if (el.refresh) { el.refresh.disabled = true; el.refresh.textContent = "Loading…"; }
    clearMessage(el.message);
    try {
      if (!window.refundSupabaseReady || !client) {
        throw new Error("Supabase is not configured. Check js/config.js and the Supabase client script.");
      }
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw sessionError;
      const session = sessionData?.session;
      if (!session?.user) {
        window.location.replace("../login.html");
        return;
      }
      currentUser = session.user;
      el.email.textContent = currentUser.email || "Signed in";

      const [profileResult, claimsResult, balancesResult, payoutsResult] = await Promise.all([
        client.from("profiles").select("id, full_name, identity_status, account_status").eq("id", currentUser.id).maybeSingle(),
        client.from("claims").select("id, case_reference, title, status, category, created_at").eq("user_id", currentUser.id).order("created_at", { ascending: false }).limit(200),
        client.from("claim_recovery_balances").select("recovery_account_id, claim_id, case_reference, user_id, claim_title, recoverable_amount, recovered_amount, outstanding_amount, currency, fully_recovered, payout_eligible, created_at, updated_at").eq("user_id", currentUser.id).order("created_at", { ascending: false }).limit(200),
        client.from("payout_requests").select("id, recovery_account_id, user_id, amount, currency, method, status, decision_reason, paid_at, created_at, updated_at").eq("user_id", currentUser.id).order("created_at", { ascending: false }).limit(100)
      ]);

      if (profileResult.error) throw new Error(`Could not read account status: ${profileResult.error.message}`);
      if (claimsResult.error) throw new Error(`Could not load your claims: ${claimsResult.error.message}`);
      if (balancesResult.error) throw new Error(`Could not load recovery balances: ${balancesResult.error.message}`);
      if (payoutsResult.error) throw new Error(`Could not load payout requests: ${payoutsResult.error.message}`);

      currentProfile = profileResult.data;
      const claims = claimsResult.data || [];
      claimsById = new Map(claims.map((claim) => [claim.id, claim]));
      recoveryAccounts = balancesResult.data || [];
      payoutRequests = payoutsResult.data || [];
      setIdentityStrip(currentProfile);
      renderSummary();
      renderRecoveryCases();
      renderPayoutHistory();
    } catch (error) {
      console.error("Customer recovery data could not be loaded:", error?.message || error);
      showMessage(el.message, error?.message || "We couldn't load your recovery information. Please refresh the page.", "error");
      el.summary.replaceChildren();
      el.cases.replaceChildren();
      el.payouts.replaceChildren();
      el.cases.append(make("div", "cr-empty-state", "Your recovery records couldn't be loaded. Check your connection and refresh the page."));
    } finally {
      loading = false;
      if (el.refresh) { el.refresh.disabled = false; el.refresh.innerHTML = "<span aria-hidden=\"true\">↻</span> Refresh"; }
    }
  }

  function wireEvents() {
    el.refresh?.addEventListener("click", loadData);
    el.signOut?.addEventListener("click", async () => {
      el.signOut.disabled = true;
      try {
        const { error } = await client.auth.signOut();
        if (error) throw error;
        window.location.assign("../login.html");
      } catch (error) {
        console.error("Sign out failed:", error?.message || error);
        showMessage(el.message, "We couldn't sign you out. Please try again.", "error");
        el.signOut.disabled = false;
      }
    });
    el.method?.addEventListener("change", updateMethodFields);
    el.form?.addEventListener("submit", submitPayout);
    el.closeX?.addEventListener("click", closePayoutDialog);
    el.cancel?.addEventListener("click", closePayoutDialog);
    el.dialog?.addEventListener("click", (event) => {
      if (event.target === el.dialog) closePayoutDialog();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && el.dialog?.open) closePayoutDialog();
    });
  }

  if (el.year) el.year.textContent = String(new Date().getFullYear());
  wireEvents();
  updateMethodFields();
  loadData();
})();
