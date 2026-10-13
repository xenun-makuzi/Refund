(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const workspace = document.body.dataset.workspace || "customer";
  const isStaffWorkspace = workspace === "staff";
  const client = window.refundSupabase;
  const categoryLabels = {
    general: "General question", account_access: "Account access", identity_verification: "Identity verification",
    claim_issue: "Claim or investigation", recovery_payout: "Recovery or payout", loan_application: "Loan application",
    loan_withdrawal: "Loan withdrawal", complaint: "Complaint or decision review", privacy_request: "Privacy request", other: "Other"
  };
  const statusLabels = {
    open: "Open", in_progress: "In progress", waiting_for_customer: "Waiting for customer",
    escalated: "Escalated", resolved: "Resolved", closed: "Closed"
  };
  const priorityLabels = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
  let currentUser = null;
  let currentRoles = [];
  let tickets = [];
  let selectedTicket = null;
  let assignees = [];

  const dateText = (value) => {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], {
      year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
  };
  const canManage = () => currentRoles.some((role) => ["admin", "super_admin", "support_agent"].includes(role));
  const canUseStaff = () => currentRoles.some((role) => ["admin", "super_admin", "support_agent", "investigator"].includes(role));

  function showAlert(text, kind = "info") {
    const box = $("#support-alert");
    if (!box) return;
    box.textContent = text;
    box.className = `comms-alert ${kind}`;
    box.hidden = !text;
  }

  function setButtonBusy(button, busy, busyText = "Working…") {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
    }
  }

  function addTextElement(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text == null ? "" : String(text);
    parent.append(element);
    return element;
  }

  function prettyEnum(value) {
    return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (match) => match.toUpperCase());
  }

  function emptyMessage(container, text) {
    container.replaceChildren();
    addTextElement(container, "p", "support-empty", text);
  }

  async function loadUserClaims() {
    const select = $("#support-related-claim");
    if (!select) return;
    const { data, error } = await client.from("claims")
      .select("id, case_reference, title")
      .order("created_at", { ascending: false }).limit(100);
    if (error) {
      // The optional link field should not block opening a general support request.
      return;
    }
    (data || []).forEach((claim) => {
      const option = document.createElement("option");
      option.value = claim.id;
      option.textContent = `${claim.case_reference} — ${claim.title}`;
      select.append(option);
    });
  }

  async function loadAssignees() {
    if (!isStaffWorkspace || !canManage()) return;
    const { data, error } = await client.rpc("list_support_assignees");
    if (error) {
      showAlert(`Couldn't load assignable staff: ${error.message}`, "error");
      return;
    }
    const grouped = new Map();
    (data || []).forEach((item) => {
      if (!grouped.has(item.user_id)) grouped.set(item.user_id, {
        id: item.user_id,
        name: item.full_name || item.email || "Staff member",
        email: item.email || "",
        roles: []
      });
      const row = grouped.get(item.user_id);
      if (item.role && !row.roles.includes(item.role)) row.roles.push(item.role);
    });
    assignees = [...grouped.values()];
    const select = $("#support-new-assignee");
    if (!select) return;
    select.replaceChildren();
    const unassigned = document.createElement("option");
    unassigned.value = "";
    unassigned.textContent = "Unassigned";
    select.append(unassigned);
    assignees.forEach((person) => {
      const option = document.createElement("option");
      option.value = person.id;
      option.textContent = `${person.name}${person.email ? ` — ${person.email}` : ""} (${person.roles.map(prettyEnum).join(", ")})`;
      select.append(option);
    });
  }

  function ticketPassesFilters(ticket) {
    if (isStaffWorkspace) {
      const status = $("#support-admin-status")?.value || "all";
      const priority = $("#support-admin-priority")?.value || "all";
      const search = ($("#support-search")?.value || "").trim().toLowerCase();
      if (status !== "all" && ticket.status !== status) return false;
      if (priority !== "all" && ticket.priority !== priority) return false;
      if (search && ![ticket.ticket_reference, ticket.subject, ticket.customer_email].some((v) => String(v || "").toLowerCase().includes(search))) return false;
    } else {
      const status = $("#support-status-filter")?.value || "all";
      if (status !== "all" && ticket.status !== status) return false;
    }
    return true;
  }

  function renderTicketList() {
    const list = $("#support-ticket-list");
    if (!list) return;
    list.replaceChildren();
    const visibleTickets = tickets.filter(ticketPassesFilters);
    const queueCount = $("#support-queue-count");
    if (queueCount) queueCount.textContent = `${visibleTickets.length} ticket${visibleTickets.length === 1 ? "" : "s"}`;
    if (!visibleTickets.length) {
      emptyMessage(list, tickets.length ? "No tickets match these filters." : (isStaffWorkspace ? "There are no support tickets in the queue yet." : "You haven't opened a support ticket yet."));
      return;
    }
    visibleTickets.forEach((ticket) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `support-ticket-card${selectedTicket?.id === ticket.id ? " is-active" : ""}`;
      button.setAttribute("aria-pressed", String(selectedTicket?.id === ticket.id));
      const top = document.createElement("div");
      top.className = "support-ticket-card-top";
      addTextElement(top, "span", "support-ticket-ref", ticket.ticket_reference);
      const status = addTextElement(top, "span", "support-status-chip", statusLabels[ticket.status] || prettyEnum(ticket.status));
      status.dataset.status = ticket.status;
      button.append(top);
      addTextElement(button, "strong", "support-ticket-subject", ticket.subject);
      if (isStaffWorkspace) addTextElement(button, "span", "support-ticket-category", ticket.customer_email || "Customer email unavailable");
      const bottom = document.createElement("div");
      bottom.className = "support-ticket-card-bottom";
      addTextElement(bottom, "span", "", categoryLabels[ticket.category] || prettyEnum(ticket.category));
      const priority = addTextElement(bottom, "span", "support-priority-chip", priorityLabels[ticket.priority] || prettyEnum(ticket.priority));
      priority.dataset.priority = ticket.priority;
      const date = addTextElement(bottom, "span", "", dateText(ticket.updated_at));
      date.title = "Last updated";
      button.append(bottom);
      button.addEventListener("click", () => openTicket(ticket.id));
      list.append(button);
    });
  }

  async function loadTickets() {
    const list = $("#support-ticket-list");
    if (list && !tickets.length) emptyMessage(list, "Loading support requests…");
    const { data, error } = await client.from("support_tickets")
      .select("id, ticket_reference, customer_id, customer_email, subject, category, status, priority, related_claim_id, assigned_to, created_at, updated_at, resolved_at, closed_at")
      .order("updated_at", { ascending: false }).limit(250);
    if (error) {
      showAlert(`Couldn't load support tickets: ${error.message}`, "error");
      if (list) emptyMessage(list, "The support queue could not be loaded. Check database migration 006 and the access policies.");
      return;
    }
    tickets = data || [];
    renderTicketList();
    const wanted = new URLSearchParams(window.location.search).get("ticket");
    if (wanted && tickets.some((ticket) => ticket.id === wanted)) {
      await openTicket(wanted, false);
    } else if (selectedTicket && tickets.some((ticket) => ticket.id === selectedTicket.id)) {
      selectedTicket = tickets.find((ticket) => ticket.id === selectedTicket.id);
      renderTicketList();
    }
  }

  function addThreadMessage(message) {
    const thread = $("#support-thread");
    const own = message.sender_id === currentUser.id;
    const internal = message.visibility === "internal";
    const article = document.createElement("article");
    article.className = `support-message${own ? " is-own" : ""}${internal ? " is-internal" : ""}`;
    const meta = document.createElement("div");
    meta.className = "support-message-meta";
    const senderName = isStaffWorkspace && own ? "You" : (own ? "You" : (internal ? "Staff internal note" : (isStaffWorkspace ? "Customer / Refund team" : "Refund team")));
    addTextElement(meta, "strong", "", senderName);
    if (internal) addTextElement(meta, "span", "support-internal-label", "Internal staff note");
    addTextElement(meta, "time", "", dateText(message.created_at));
    const body = addTextElement(article, "p", "support-message-body", message.body);
    article.prepend(meta);
    thread.append(article);
  }

  async function loadTicketThread(ticket) {
    const thread = $("#support-thread");
    emptyMessage(thread, "Loading conversation…");
    const { data: messages, error: messagesError } = await client.from("support_ticket_messages")
      .select("id, ticket_id, sender_id, body, visibility, created_at")
      .eq("ticket_id", ticket.id).order("created_at", { ascending: true }).limit(300);
    if (messagesError) {
      emptyMessage(thread, `Couldn't load messages: ${messagesError.message}`);
      return;
    }
    thread.replaceChildren();
    if (!messages?.length) emptyMessage(thread, "No messages yet.");
    else messages.forEach(addThreadMessage);

    const { data: events, error: eventsError } = await client.from("support_ticket_events")
      .select("id, event_type, old_status, new_status, old_priority, new_priority, event_note, customer_visible, created_at")
      .eq("ticket_id", ticket.id).order("created_at", { ascending: true }).limit(200);
    renderEvents(eventsError ? [] : (events || []), eventsError);
  }

  function renderEvents(events, error) {
    const container = $("#support-audit-events");
    if (!container) return;
    container.replaceChildren();
    addTextElement(container, "h3", "support-subheading", "Ticket history");
    if (error) {
      addTextElement(container, "p", "comms-muted", `History could not be loaded: ${error.message}`);
      return;
    }
    if (!events.length) {
      addTextElement(container, "p", "comms-muted", "No history yet.");
      return;
    }
    events.slice().reverse().forEach((event) => {
      const row = document.createElement("div");
      row.className = "support-event";
      addTextElement(row, "strong", "", prettyEnum(event.event_type));
      let detail = event.event_note || "";
      if (event.old_status && event.new_status && event.old_status !== event.new_status) {
        detail = `${statusLabels[event.old_status] || prettyEnum(event.old_status)} → ${statusLabels[event.new_status] || prettyEnum(event.new_status)}${detail ? ` · ${detail}` : ""}`;
      }
      if (event.old_priority && event.new_priority && event.old_priority !== event.new_priority) {
        detail = `${priorityLabels[event.old_priority]} → ${priorityLabels[event.new_priority]}${detail ? ` · ${detail}` : ""}`;
      }
      if (detail) addTextElement(row, "p", "", detail);
      addTextElement(row, "time", "", dateText(event.created_at));
      container.append(row);
    });
  }

  async function openTicket(ticketId, updateUrl = true) {
    const ticket = tickets.find((item) => item.id === ticketId);
    if (!ticket) return;
    selectedTicket = ticket;
    renderTicketList();
    const detail = $("#support-ticket-detail");
    detail.hidden = false;
    $("#support-detail-title").textContent = `${ticket.ticket_reference} · ${ticket.subject}`;
    $("#support-detail-meta").textContent = `${categoryLabels[ticket.category] || prettyEnum(ticket.category)} · Opened ${dateText(ticket.created_at)}${isStaffWorkspace ? ` · ${ticket.customer_email || "Email unavailable"}` : ""}`;
    const statusChip = $("#support-detail-status");
    statusChip.textContent = statusLabels[ticket.status] || prettyEnum(ticket.status);
    statusChip.dataset.status = ticket.status;
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("ticket", ticket.id);
      history.replaceState({}, "", url);
    }

    if (isStaffWorkspace) {
      const description = $("#support-ticket-description");
      description.replaceChildren();
      const row = document.createElement("div");
      row.className = "support-ticket-card-bottom";
      addTextElement(row, "span", "", `Priority: ${priorityLabels[ticket.priority] || prettyEnum(ticket.priority)}`);
      addTextElement(row, "span", "", ticket.related_claim_id ? `Linked claim: ${ticket.related_claim_id}` : "No linked claim");
      description.append(row);
      $("#support-new-status").value = ticket.status;
      $("#support-new-priority").value = ticket.priority;
      const assigneeSelect = $("#support-new-assignee");
      if (canManage()) {
        assigneeSelect.disabled = false;
        assigneeSelect.value = ticket.assigned_to || "";
      } else {
        assigneeSelect.disabled = true;
        $("#support-investigator-note").hidden = false;
      }
      $("#support-new-priority").disabled = !canManage();
      $("#support-customer-note").value = "";
    } else {
      const closed = ticket.status === "closed";
      $("#support-reply-form").hidden = closed;
      $("#support-escalate-section").hidden = ["closed", "resolved", "escalated"].includes(ticket.status);
      $("#support-show-escalation").hidden = false;
      $("#support-escalation-form").hidden = true;
      $("#support-reply-body").value = "";
      $("#support-escalation-reason").value = "";
    }
    await loadTicketThread(ticket);
    detail.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function createTicket(event) {
    event.preventDefault();
    const button = $("#support-create-submit");
    setButtonBusy(button, true, "Submitting…");
    const category = $("#support-category").value;
    const subject = $("#support-subject").value.trim();
    const message = $("#support-initial-message").value.trim();
    const related = $("#support-related-claim").value || null;
    const { data, error } = await client.rpc("create_support_ticket", {
      p_category: category, p_subject: subject, p_initial_message: message, p_related_claim_id: related
    });
    setButtonBusy(button, false);
    if (error) {
      showAlert(`Ticket could not be created: ${error.message}`, "error");
      return;
    }
    $("#support-create-form").reset();
    showAlert("Your support request was created. Keep its reference number for future follow-up.", "success");
    await loadTickets();
    const ticketId = typeof data === "string" ? data : (Array.isArray(data) ? data[0] : null);
    if (ticketId) await openTicket(ticketId);
  }

  async function replyTicket(event) {
    event.preventDefault();
    if (!selectedTicket) return;
    const button = $("#support-reply-submit");
    setButtonBusy(button, true, "Sending…");
    const visibility = isStaffWorkspace ? $("#support-reply-visibility").value : "customer";
    const { error } = await client.rpc("reply_support_ticket", {
      p_ticket_id: selectedTicket.id,
      p_body: $("#support-reply-body").value.trim(),
      p_visibility: visibility
    });
    setButtonBusy(button, false);
    if (error) {
      showAlert(`Reply failed: ${error.message}`, "error");
      return;
    }
    $("#support-reply-body").value = "";
    showAlert(visibility === "internal" ? "Internal note added." : "Reply sent.", "success");
    const ticketId = selectedTicket.id;
    await loadTickets();
    await openTicket(ticketId, false);
  }

  async function updateTicket(event) {
    event.preventDefault();
    if (!selectedTicket || !isStaffWorkspace) return;
    const button = $("#support-update-submit");
    setButtonBusy(button, true, "Saving…");
    const status = $("#support-new-status").value;
    const priority = canManage() ? $("#support-new-priority").value : selectedTicket.priority;
    const assignee = canManage() ? ($("#support-new-assignee").value || null) : selectedTicket.assigned_to;
    const note = $("#support-customer-note").value.trim() || null;
    const { error } = await client.rpc("staff_update_support_ticket", {
      p_ticket_id: selectedTicket.id,
      p_status: status,
      p_priority: priority,
      p_assigned_to: assignee,
      p_customer_note: note
    });
    setButtonBusy(button, false);
    if (error) {
      showAlert(`Ticket update failed: ${error.message}`, "error");
      return;
    }
    showAlert("Ticket changes saved.", "success");
    const ticketId = selectedTicket.id;
    await loadTickets();
    await openTicket(ticketId, false);
  }

  async function escalateTicket(event) {
    event.preventDefault();
    if (!selectedTicket || isStaffWorkspace) return;
    const button = $("#support-escalate-submit");
    setButtonBusy(button, true, "Submitting…");
    const { error } = await client.rpc("customer_escalate_support_ticket", {
      p_ticket_id: selectedTicket.id,
      p_reason: $("#support-escalation-reason").value.trim()
    });
    setButtonBusy(button, false);
    if (error) {
      showAlert(`Escalation failed: ${error.message}`, "error");
      return;
    }
    $("#support-escalation-reason").value = "";
    $("#support-escalation-form").hidden = true;
    showAlert("Your escalation request has been submitted to the support team.", "success");
    const ticketId = selectedTicket.id;
    await loadTickets();
    await openTicket(ticketId, false);
  }

  function bindEvents() {
    $("#support-sign-out")?.addEventListener("click", async () => {
      const { error } = await client.auth.signOut();
      if (error) showAlert(`Sign out failed: ${error.message}`, "error");
      else window.location.href = "../login.html";
    });
    $("#support-create-form")?.addEventListener("submit", createTicket);
    $("#support-reply-form")?.addEventListener("submit", replyTicket);
    $("#support-update-form")?.addEventListener("submit", updateTicket);
    $("#support-escalate-form")?.addEventListener("submit", escalateTicket);
    $("#support-show-escalation")?.addEventListener("click", () => {
      $("#support-escalation-form").hidden = false;
      $("#support-show-escalation").hidden = true;
      $("#support-escalation-reason").focus();
    });
    $("#support-refresh")?.addEventListener("click", loadTickets);
    $("#support-status-filter")?.addEventListener("change", renderTicketList);
    $("#support-admin-status")?.addEventListener("change", renderTicketList);
    $("#support-admin-priority")?.addEventListener("change", renderTicketList);
    $("#support-search")?.addEventListener("input", renderTicketList);
  }

  async function initialize() {
    if (!window.refundSupabaseReady || !client) {
      showAlert("Supabase is not connected. Check js/config.js and js/supabase-client.js.", "error");
      return;
    }
    const { data: { session }, error: sessionError } = await client.auth.getSession();
    if (sessionError || !session) {
      window.location.href = "../login.html";
      return;
    }
    currentUser = session.user;
    $("#support-user-email").textContent = currentUser.email || "Signed in";
    const { data: roleRows, error: roleError } = await client.from("user_roles").select("role").eq("user_id", currentUser.id);
    if (roleError) {
      showAlert(`Couldn't verify your account role: ${roleError.message}`, "error");
      return;
    }
    currentRoles = (roleRows || []).map((row) => row.role);
    if (isStaffWorkspace && !canUseStaff()) {
      showAlert("Staff access is required to open this support queue.", "error");
      return;
    }
    if (!isStaffWorkspace && !currentRoles.includes("customer")) {
      // Staff roles remain usable from the customer-facing side only if this account also has a customer role.
      // If not, redirect to the operations view rather than creating support requests from a staff-only account.
      if (canUseStaff()) {
        window.location.href = "../admin/support.html";
        return;
      }
    }
    bindEvents();
    if (!isStaffWorkspace) await loadUserClaims();
    if (isStaffWorkspace && !canManage()) {
      $("#support-update-form").querySelectorAll("select").forEach((select) => {
        if (select.id !== "support-new-status") select.disabled = true;
      });
      $("#support-investigator-note").hidden = false;
      $("#support-customer-note").placeholder = "Customer-visible explanation for status changes…";
    }
    await loadAssignees();
    await loadTickets();
    const refreshButton = $("#support-refresh");
    if (refreshButton) {
      window.setInterval(() => {
        if (document.visibilityState === "visible") loadTickets();
      }, 45000);
    }
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
