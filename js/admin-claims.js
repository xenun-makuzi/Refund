(() => {
  "use strict";

  const client = window.refundSupabase;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const el = {
    globalMessage: $("#admin-global-message"), userName: $("#admin-user-name"), userRole: $("#admin-user-role"),
    signOut: $("#admin-sign-out"), refresh: $("#refresh-claims"), tableBody: $("#claims-table-body"),
    queueEmpty: $("#queue-empty"), resultsCount: $("#results-count"), search: $("#claim-search"),
    statusFilter: $("#status-filter"), categoryFilter: $("#category-filter"), clearFilters: $("#clear-filters"),
    statTotal: $("#stat-total"), statReview: $("#stat-review"), statUnassigned: $("#stat-unassigned"), statAwaiting: $("#stat-awaiting"),
    countAll: $("#count-all"), countReview: $("#count-review"), countUnassigned: $("#count-unassigned"), countAwaiting: $("#count-awaiting"),
    detail: $("#case-detail"), closeDetail: $("#close-case-detail"), detailMessage: $("#detail-message"),
    detailTitle: $("#case-detail-title"), detailStatus: $("#detail-status"), detailReference: $("#detail-reference"),
    claimTitle: $("#detail-claim-title"), origin: $("#detail-origin"), claimant: $("#detail-claimant"), category: $("#detail-category"),
    submitted: $("#detail-submitted"), amount: $("#detail-amount"), merchant: $("#detail-merchant"), transactionDate: $("#detail-transaction-date"),
    description: $("#detail-description"), investigatorSelect: $("#investigator-select"), assignForm: $("#assign-form"), assignButton: $("#assign-button"), assignMessage: $("#assign-message"),
    statusForm: $("#status-form"), newStatus: $("#new-status"), statusCustomerMessage: $("#status-customer-message"), statusButton: $("#status-button"), statusMessage: $("#status-message"),
    activityForm: $("#activity-form"), activityVisibility: $("#activity-visibility"), activityBody: $("#activity-body"), activityButton: $("#activity-button"), activityFormMessage: $("#activity-form-message"),
    activityTimeline: $("#activity-timeline"), activityCount: $("#activity-count"), evidenceList: $("#evidence-list"), evidenceCount: $("#evidence-count")
  };

  const statusLabels = {
    submitted: "Submitted", under_review: "Under review", awaiting_information: "Awaiting information",
    investigation_in_progress: "Investigation in progress", recovery_in_progress: "Recovery in progress",
    partially_recovered: "Partially recovered", recovery_complete: "Recovery complete",
    not_eligible: "Not eligible", closed: "Closed"
  };
  const categoryLabels = {
    purchase_refund: "Purchase refund", scam_recovery: "Scam recovery", tax_refund: "Tax refund",
    service_dispute: "Service dispute", other: "Other"
  };
  const closedStatuses = new Set(["recovery_complete", "not_eligible", "closed"]);
  const reviewStatuses = new Set(["submitted"]);
  const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

  let currentUser = null;
  let currentRole = null;
  let claims = [];
  let profileById = new Map();
  let investigatorList = [];
  let selectedClaim = null;
  let activeQuickFilter = "all";

  function message(node, text, type = "info") {
    if (!node) return;
    node.hidden = false;
    node.className = `${node === el.globalMessage || node === el.detailMessage ? "admin-message" : "inline-message"}${type === "error" ? " is-error" : type === "warning" ? " is-warning" : ""}`;
    node.textContent = text;
  }

  function clearMessage(node) {
    if (!node) return;
    node.hidden = true;
    node.textContent = "";
    node.className = node === el.globalMessage || node === el.detailMessage ? "admin-message" : "inline-message";
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle("is-loading", busy);
    button.setAttribute("aria-busy", String(busy));
    if (label && !button.dataset.originalLabel) button.dataset.originalLabel = button.textContent.trim();
    if (label) button.textContent = busy ? label : (button.dataset.originalLabel || label);
  }

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }

  function safeDate(value, withTime = false) {
    if (!value) return "—";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "—";
    return (withTime ? dateTimeFormatter : dateFormatter).format(parsed);
  }

  function safeMoney(value, currency) {
    if (value === null || value === undefined || value === "") return "Not provided";
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: (currency || "USD").trim(), maximumFractionDigits: 2 }).format(Number(value));
    } catch {
      return `${currency || "USD"} ${Number(value).toFixed(2)}`;
    }
  }

  function statusClass(status) {
    if (status === "submitted") return "status-pill status-submitted";
    if (status === "under_review" || status === "investigation_in_progress") return "status-pill status-review";
    if (status === "awaiting_information") return "status-pill status-awaiting";
    if (status === "recovery_in_progress" || status === "partially_recovered") return "status-pill status-recovery";
    if (status === "recovery_complete") return "status-pill status-complete";
    if (closedStatuses.has(status)) return "status-pill status-closed";
    return "status-pill";
  }

  function setStatusPill(target, status) {
    if (!target) return;
    target.className = statusClass(status);
    target.textContent = statusLabels[status] || String(status || "Unknown").replaceAll("_", " ");
  }

  function currentFilterMatches(claim) {
    if (activeQuickFilter === "needs_review" && !reviewStatuses.has(claim.status)) return false;
    if (activeQuickFilter === "unassigned" && claim.assigned_to) return false;
    if (activeQuickFilter === "awaiting_information" && claim.status !== "awaiting_information") return false;
    if (el.statusFilter?.value !== "all" && claim.status !== el.statusFilter.value) return false;
    if (el.categoryFilter?.value !== "all" && claim.category !== el.categoryFilter.value) return false;
    const term = (el.search?.value || "").trim().toLowerCase();
    if (term) {
      const claimant = profileById.get(claim.user_id)?.full_name || "";
      const haystack = [claim.case_reference, claim.title, claim.merchant_name, claimant, categoryLabels[claim.category], statusLabels[claim.status]].join(" ").toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  }

  function matchingClaims() {
    return claims.filter(currentFilterMatches);
  }

  function updateStats() {
    const total = claims.length;
    const review = claims.filter((c) => reviewStatuses.has(c.status)).length;
    const unassigned = claims.filter((c) => !c.assigned_to && !closedStatuses.has(c.status)).length;
    const awaiting = claims.filter((c) => c.status === "awaiting_information").length;
    el.statTotal.textContent = String(total);
    el.statReview.textContent = String(review);
    el.statUnassigned.textContent = String(unassigned);
    el.statAwaiting.textContent = String(awaiting);
    el.countAll.textContent = String(total);
    el.countReview.textContent = String(review);
    el.countUnassigned.textContent = String(unassigned);
    el.countAwaiting.textContent = String(awaiting);
  }

  function renderTable() {
    const visible = matchingClaims();
    el.tableBody.replaceChildren();
    el.resultsCount.textContent = `${visible.length} of ${claims.length} case${claims.length === 1 ? "" : "s"}`;
    el.queueEmpty.hidden = visible.length > 0;
    if (!visible.length) {
      const row = node("tr");
      const cell = node("td", "table-placeholder", claims.length ? "No cases match the selected filters." : "No claims are available to your admin account yet.");
      cell.colSpan = 7;
      row.append(cell);
      el.tableBody.append(row);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const claim of visible) {
      const row = node("tr");
      const identityCell = node("td");
      identityCell.append(node("span", "case-reference", claim.case_reference));
      identityCell.append(node("span", "case-name", claim.title));
      const claimantName = profileById.get(claim.user_id)?.full_name || "Profile unavailable";
      identityCell.append(node("span", "case-subline", claimantName));
      const typeCell = node("td");
      typeCell.append(node("span", "type-label", categoryLabels[claim.category] || claim.category));
      const dateCell = node("td", "cell-date", safeDate(claim.created_at));
      const amountCell = node("td", "currency-cell", safeMoney(claim.requested_amount, claim.currency));
      const statusCell = node("td");
      statusCell.append(node("span", statusClass(claim.status), statusLabels[claim.status] || claim.status));
      const assignedCell = node("td", "assignee-cell");
      const assignedName = claim.assigned_to ? (profileById.get(claim.assigned_to)?.full_name || "Assigned investigator") : "Unassigned";
      assignedCell.append(node("span", "assignee-label", assignedName));
      const actionCell = node("td");
      const open = node("button", "case-primary-button", selectedClaim?.id === claim.id ? "Viewing" : "Review case →");
      open.type = "button";
      open.addEventListener("click", () => openClaim(claim.id));
      actionCell.append(open);
      row.append(identityCell, typeCell, dateCell, amountCell, statusCell, assignedCell, actionCell);
      if (selectedClaim?.id === claim.id) row.style.background = "#f5fbf7";
      fragment.append(row);
    }
    el.tableBody.append(fragment);
  }

  async function requireAdmin() {
    if (!window.refundSupabaseReady || !client) {
      message(el.globalMessage, "Supabase is not configured. Check js/config.js and reload this page.", "warning");
      return false;
    }
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    currentUser = sessionData?.session?.user || null;
    if (!currentUser) {
      window.location.replace("../login.html");
      return false;
    }

    const { data: roleRows, error: roleError } = await client
      .from("user_roles")
      .select("role")
      .eq("user_id", currentUser.id);
    if (roleError) throw roleError;
    const roles = (roleRows || []).map((entry) => entry.role);
    currentRole = roles.includes("super_admin") ? "super_admin" : roles.includes("admin") ? "admin" : null;
    if (!currentRole) {
      message(el.globalMessage, "Access denied. This account does not have the administrator role. Assign the role from a trusted Supabase SQL Editor session, then reload.", "error");
      el.userName.textContent = currentUser.email || "Signed in user";
      el.userRole.textContent = "No administrator role";
      [el.refresh, el.assignButton, el.statusButton, el.activityButton].forEach((button) => { if (button) button.disabled = true; });
      return false;
    }
    el.userName.textContent = currentUser.email || "Administrator";
    el.userRole.textContent = currentRole === "super_admin" ? "Super administrator" : "Administrator";
    return true;
  }

  async function loadInvestigators() {
    const { data: roles, error: rolesError } = await client.from("user_roles").select("user_id").eq("role", "investigator");
    if (rolesError) throw rolesError;
    const ids = [...new Set((roles || []).map((item) => item.user_id))];
    investigatorList = [];
    if (ids.length) {
      const { data: people, error: peopleError } = await client.from("profiles").select("id, full_name, account_status").in("id", ids);
      if (peopleError) throw peopleError;
      const byId = new Map((people || []).map((person) => [person.id, person]));
      investigatorList = ids.map((id) => byId.get(id)).filter((person) => person && person.account_status === "active");
      investigatorList.sort((a, b) => a.full_name.localeCompare(b.full_name));
    }
    const previous = el.investigatorSelect.value;
    el.investigatorSelect.replaceChildren(new Option("Choose an investigator", ""));
    for (const person of investigatorList) {
      const option = new Option(person.full_name || "Investigator", person.id);
      el.investigatorSelect.add(option);
    }
    if (previous && investigatorList.some((person) => person.id === previous)) el.investigatorSelect.value = previous;
    if (!investigatorList.length) {
      el.investigatorSelect.replaceChildren(new Option("No active investigators have been assigned this role", ""));
      el.assignButton.disabled = true;
    } else {
      el.assignButton.disabled = false;
    }
  }

  async function loadClaims({ silent = false } = {}) {
    if (!silent) {
      el.tableBody.replaceChildren();
      const row = node("tr");
      const cell = node("td", "table-placeholder", "Loading the claims queue…");
      cell.colSpan = 7;
      row.append(cell);
      el.tableBody.append(row);
      el.refresh.disabled = true;
    }
    clearMessage(el.globalMessage);
    try {
      const { data, error } = await client
        .from("claims")
        .select("id, case_reference, user_id, category, title, description, merchant_name, transaction_date, requested_amount, currency, origin, partner_organization_id, status, assigned_to, assigned_by, assigned_at, resolution_summary, resolved_by, resolved_at, closed_at, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      claims = data || [];
      const ids = [...new Set(claims.flatMap((claim) => [claim.user_id, claim.assigned_to].filter(Boolean)))];
      profileById = new Map();
      if (ids.length) {
        const { data: profiles, error: profilesError } = await client.from("profiles").select("id, full_name, account_status").in("id", ids);
        if (profilesError) throw profilesError;
        profileById = new Map((profiles || []).map((profile) => [profile.id, profile]));
      }
      updateStats();
      renderTable();
      if (selectedClaim) {
        const latest = claims.find((claim) => claim.id === selectedClaim.id);
        if (latest) {
          selectedClaim = latest;
          await renderClaimDetails(latest);
        } else {
          selectedClaim = null;
          el.detail.hidden = true;
        }
      }
    } catch (error) {
      console.error("Unable to load claims:", error);
      message(el.globalMessage, `Could not load the claims queue. ${error.message || "Check the table policies and Supabase connection."}`, "error");
      el.tableBody.replaceChildren();
      const row = node("tr");
      const cell = node("td", "table-placeholder", "Queue could not be loaded. Fix the error above and refresh.");
      cell.colSpan = 7;
      row.append(cell);
      el.tableBody.append(row);
    } finally {
      el.refresh.disabled = false;
    }
  }

  async function openClaim(claimId) {
    const claim = claims.find((item) => item.id === claimId);
    if (!claim) return;
    selectedClaim = claim;
    renderTable();
    el.detail.hidden = false;
    clearMessage(el.detailMessage);
    await renderClaimDetails(claim);
    el.detail.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  async function renderClaimDetails(claim) {
    selectedClaim = claim;
    const profile = profileById.get(claim.user_id);
    el.detailTitle.textContent = claim.title;
    el.detailReference.textContent = `${claim.case_reference} · Created ${safeDate(claim.created_at, true)}`;
    setStatusPill(el.detailStatus, claim.status);
    el.claimTitle.textContent = claim.title;
    el.origin.textContent = claim.origin === "partner_referral" ? "Partner referred" : "Direct claim";
    el.claimant.textContent = profile?.full_name || "Profile unavailable";
    el.category.textContent = categoryLabels[claim.category] || claim.category;
    el.submitted.textContent = safeDate(claim.created_at, true);
    el.amount.textContent = safeMoney(claim.requested_amount, claim.currency);
    el.merchant.textContent = claim.merchant_name || "Not provided";
    el.transactionDate.textContent = safeDate(claim.transaction_date);
    el.description.textContent = claim.description || "No description available.";
    el.newStatus.value = claim.status;
    el.statusCustomerMessage.value = "";
    el.investigatorSelect.value = claim.assigned_to || "";
    el.activityBody.value = "";
    clearMessage(el.assignMessage); clearMessage(el.statusMessage); clearMessage(el.activityFormMessage); clearMessage(el.detailMessage);

    el.assignButton.disabled = !investigatorList.length;
    await Promise.all([loadActivity(claim), loadEvidence(claim)]);
  }

  async function loadActivity(claim) {
    el.activityTimeline.replaceChildren(node("p", "muted-small", "Loading case activity…"));
    try {
      const { data, error } = await client.from("claim_activity")
        .select("id, actor_id, activity_type, visibility, body, created_at")
        .eq("claim_id", claim.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const items = data || [];
      el.activityCount.textContent = `${items.length} entr${items.length === 1 ? "y" : "ies"}`;
      const actorIds = [...new Set(items.map((item) => item.actor_id).filter(Boolean))].filter((id) => !profileById.has(id));
      if (actorIds.length) {
        const { data: people, error: peopleError } = await client.from("profiles").select("id, full_name").in("id", actorIds);
        if (!peopleError) (people || []).forEach((profile) => profileById.set(profile.id, profile));
      }
      el.activityTimeline.replaceChildren();
      if (!items.length) {
        el.activityTimeline.append(node("p", "muted-small", "No activity is recorded on this case yet."));
        return;
      }
      for (const item of items) {
        const entry = node("div", "timeline-entry");
        const rail = node("div", "timeline-rail");
        rail.append(node("span", `timeline-dot${item.visibility === "internal" ? " internal" : ""}`));
        const content = node("div", "timeline-content");
        const heading = node("div", "timeline-heading");
        const actor = profileById.get(item.actor_id)?.full_name || (item.actor_id === currentUser.id ? "You" : "System / staff");
        heading.append(node("strong", "", activityLabel(item.activity_type)));
        heading.append(node("span", `visibility-tag${item.visibility === "internal" ? " internal" : ""}`, item.visibility === "internal" ? "Internal" : "Customer-visible"));
        const body = node("p", "", item.body);
        const meta = node("div", "timeline-meta");
        meta.append(node("span", "", actor), node("span", "", " · "), node("time", "", safeDate(item.created_at, true)));
        content.append(heading, body, meta);
        entry.append(rail, content);
        el.activityTimeline.append(entry);
      }
    } catch (error) {
      console.error("Unable to load claim activity:", error);
      el.activityTimeline.replaceChildren(node("p", "muted-small", `Could not load activity: ${error.message || "Unknown error"}`));
    }
  }

  function activityLabel(type) {
    const labels = { claim_submitted: "Claim submitted", status_change: "Status changed", message: "Message", internal_note: "Internal note", claim_assigned: "Investigator assignment", evidence_uploaded: "Evidence uploaded", system: "System activity" };
    return labels[type] || String(type || "Activity").replaceAll("_", " ");
  }

  async function loadEvidence(claim) {
    el.evidenceList.replaceChildren(node("p", "muted-small", "Loading evidence records…"));
    try {
      const { data, error } = await client.from("claim_evidence")
        .select("id, uploaded_by, storage_path, original_filename, mime_type, byte_size, document_type, review_status, review_note, created_at")
        .eq("claim_id", claim.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const items = data || [];
      el.evidenceCount.textContent = `${items.length} file${items.length === 1 ? "" : "s"}`;
      el.evidenceList.replaceChildren();
      if (!items.length) {
        el.evidenceList.append(node("p", "muted-small", "No supporting documents have been uploaded."));
        return;
      }
      for (const item of items) {
        const row = node("div", "evidence-row");
        row.append(node("span", "file-symbol", item.mime_type === "application/pdf" ? "PDF" : "IMG"));
        const copy = node("div", "evidence-copy");
        copy.append(node("strong", "", item.original_filename));
        const size = Number.isFinite(Number(item.byte_size)) ? `${(Number(item.byte_size) / 1024 / 1024).toFixed(2)} MB` : "Size unavailable";
        copy.append(node("small", "", `${item.document_type.replaceAll("_", " ")} · ${size} · ${item.review_status.replaceAll("_", " ")}`));
        const open = node("button", "evidence-open-button", "Open securely");
        open.type = "button";
        open.addEventListener("click", async () => {
          open.disabled = true;
          const prior = open.textContent;
          open.textContent = "Preparing…";
          try {
            const { data: signed, error: signedError } = await client.storage.from("claim-evidence").createSignedUrl(item.storage_path, 60);
            if (signedError) throw signedError;
            const popup = window.open(signed.signedUrl, "_blank", "noopener,noreferrer");
            if (!popup) message(el.detailMessage, "The browser blocked the document window. Allow pop-ups for this local site and try again.", "warning");
          } catch (error) {
            message(el.detailMessage, `Could not open that document. ${error.message || "Check storage access policies."}`, "error");
          } finally {
            open.disabled = false;
            open.textContent = prior;
          }
        });
        row.append(copy, open);
        el.evidenceList.append(row);
      }
    } catch (error) {
      console.error("Unable to load claim evidence:", error);
      el.evidenceList.replaceChildren(node("p", "muted-small", `Could not load evidence: ${error.message || "Unknown error"}`));
    }
  }

  async function handleAssign(event) {
    event.preventDefault();
    clearMessage(el.assignMessage);
    if (!selectedClaim) return message(el.assignMessage, "Choose a case first.", "warning");
    const investigatorId = el.investigatorSelect.value;
    if (!investigatorId) return message(el.assignMessage, "Choose an active investigator.", "warning");
    setBusy(el.assignButton, true, "Saving assignment…");
    try {
      const { error } = await client.rpc("assign_claim", { p_claim_id: selectedClaim.id, p_investigator_id: investigatorId });
      if (error) throw error;
      message(el.assignMessage, "Investigator assigned. The case audit trail has been updated.", "success");
      await loadClaims({ silent: true });
    } catch (error) {
      console.error("Assignment failed:", error);
      message(el.assignMessage, error.message || "Could not assign this case.", "error");
    } finally {
      setBusy(el.assignButton, false, "Saving assignment…");
    }
  }

  async function handleStatusUpdate(event) {
    event.preventDefault();
    clearMessage(el.statusMessage);
    if (!selectedClaim) return message(el.statusMessage, "Choose a case first.", "warning");
    const nextStatus = el.newStatus.value;
    const customerMessage = el.statusCustomerMessage.value.trim();
    if (nextStatus === selectedClaim.status && !customerMessage) {
      return message(el.statusMessage, "Choose a different status or enter a customer-facing update.", "warning");
    }
    if ((nextStatus === "not_eligible" || nextStatus === "closed") && customerMessage.length === 0) {
      return message(el.statusMessage, "Add a customer-facing explanation before marking a case not eligible or closed.", "warning");
    }
    setBusy(el.statusButton, true, "Saving status…");
    try {
      const { error } = await client.rpc("update_claim_status", {
        p_claim_id: selectedClaim.id,
        p_new_status: nextStatus,
        p_customer_message: customerMessage || null
      });
      if (error) throw error;
      message(el.statusMessage, "Case status updated and customer-visible activity recorded.", "success");
      await loadClaims({ silent: true });
    } catch (error) {
      console.error("Status update failed:", error);
      message(el.statusMessage, error.message || "Could not update case status.", "error");
    } finally {
      setBusy(el.statusButton, false, "Saving status…");
    }
  }

  async function handleActivity(event) {
    event.preventDefault();
    clearMessage(el.activityFormMessage);
    if (!selectedClaim) return message(el.activityFormMessage, "Choose a case first.", "warning");
    const body = el.activityBody.value.trim();
    const visibility = el.activityVisibility.value;
    if (!body) return message(el.activityFormMessage, "Enter a note or message.", "warning");
    setBusy(el.activityButton, true, "Adding note…");
    try {
      const { error } = await client.rpc("add_claim_activity", {
        p_claim_id: selectedClaim.id,
        p_body: body,
        p_visibility: visibility
      });
      if (error) throw error;
      el.activityBody.value = "";
      message(el.activityFormMessage, visibility === "internal" ? "Internal note added to the staff audit trail." : "Customer-visible message added to the case timeline.", "success");
      await loadActivity(selectedClaim);
    } catch (error) {
      console.error("Could not add case activity:", error);
      message(el.activityFormMessage, error.message || "Could not add this note.", "error");
    } finally {
      setBusy(el.activityButton, false, "Adding note…");
    }
  }

  function bindEvents() {
    el.signOut.addEventListener("click", async () => {
      el.signOut.disabled = true;
      const { error } = await client.auth.signOut();
      if (error) {
        el.signOut.disabled = false;
        message(el.globalMessage, "Could not sign out. Please retry.", "error");
        return;
      }
      window.location.replace("../login.html");
    });
    el.refresh.addEventListener("click", () => loadClaims());
    el.search.addEventListener("input", renderTable);
    el.statusFilter.addEventListener("change", () => { activeQuickFilter = "all"; updateQuickFilterButtons(); renderTable(); });
    el.categoryFilter.addEventListener("change", renderTable);
    el.clearFilters.addEventListener("click", () => {
      el.search.value = ""; el.statusFilter.value = "all"; el.categoryFilter.value = "all"; activeQuickFilter = "all"; updateQuickFilterButtons(); renderTable();
    });
    $$('[data-quick-filter]').forEach((button) => button.addEventListener("click", () => {
      activeQuickFilter = button.dataset.quickFilter;
      if (activeQuickFilter === "awaiting_information") el.statusFilter.value = "awaiting_information";
      else el.statusFilter.value = "all";
      updateQuickFilterButtons(); renderTable();
    }));
    el.closeDetail.addEventListener("click", () => { el.detail.hidden = true; selectedClaim = null; renderTable(); });
    el.assignForm.addEventListener("submit", handleAssign);
    el.statusForm.addEventListener("submit", handleStatusUpdate);
    el.activityForm.addEventListener("submit", handleActivity);
  }

  function updateQuickFilterButtons() {
    $$('[data-quick-filter]').forEach((button) => button.classList.toggle("active", button.dataset.quickFilter === activeQuickFilter));
  }

  async function init() {
    if (!client || !window.refundSupabaseReady) {
      message(el.globalMessage, "Supabase is not configured. Confirm your Project URL and publishable key in js/config.js.", "warning");
      return;
    }
    try {
      const allowed = await requireAdmin();
      if (!allowed) return;
      bindEvents();
      await loadInvestigators();
      await loadClaims();
    } catch (error) {
      console.error("Admin workspace initialization failed:", error);
      message(el.globalMessage, `The admin workspace could not initialize. ${error.message || "Check your Supabase policies and database migration."}`, "error");
    }
  }

  init();
})();
