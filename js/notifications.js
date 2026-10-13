(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const workspace = document.body.dataset.workspace || "customer";
  const isStaff = workspace === "staff";
  const client = window.refundSupabase;
  let currentUser = null;
  let notifications = [];

  function showMessage(text, kind = "info") {
    const box = $("#notifications-message");
    if (!box) return;
    box.textContent = text;
    box.className = `comms-alert ${kind}`;
    box.hidden = !text;
  }
  const dateText = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };
  function targetFor(item) {
    if (item.related_support_ticket_id) return `support.html?ticket=${encodeURIComponent(item.related_support_ticket_id)}`;
    if (item.related_claim_id) return `messages.html?claim=${encodeURIComponent(item.related_claim_id)}`;
    if (item.related_loan_application_id || item.related_loan_withdrawal_request_id) return "loans.html";
    if (item.related_payout_request_id) return "recovery.html";
    return null;
  }
  function createNotificationCard(item) {
    const card = document.createElement("article");
    card.className = `notification-card${item.is_read ? " is-read" : " is-unread"}`;
    const icon = document.createElement("span");
    icon.className = "notification-symbol";
    icon.textContent = item.notification_type === "claim_message" ? "✉" : item.notification_type.includes("support_ticket") ? "?" : item.notification_type.includes("loan") ? "↗" : item.notification_type === "recovery_payout_update" ? "◇" : "•";
    const content = document.createElement("div");
    content.className = "notification-content";
    const title = document.createElement("h3");
    title.textContent = item.title;
    const body = document.createElement("p");
    body.textContent = item.body;
    const meta = document.createElement("time");
    meta.textContent = dateText(item.created_at);
    if (item.created_at) meta.dateTime = item.created_at;
    content.append(title, body, meta);
    const actions = document.createElement("div");
    actions.className = "notification-actions";
    const href = targetFor(item);
    if (href) {
      const open = document.createElement("a");
      open.className = "notification-open-link";
      open.href = href;
      open.textContent = "Open";
      open.addEventListener("click", async (event) => {
        if (!item.is_read) {
          event.preventDefault();
          const { error } = await client.rpc("mark_notification_read", { p_notification_id: item.id });
          if (error) showMessage(`Couldn't mark notification as read: ${error.message}`, "error");
          else window.location.href = href;
        }
      });
      actions.append(open);
    }
    if (!item.is_read) {
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "notification-mark-button";
      mark.textContent = "Mark read";
      mark.addEventListener("click", async () => {
        mark.disabled = true;
        const { error } = await client.rpc("mark_notification_read", { p_notification_id: item.id });
        if (error) {
          mark.disabled = false;
          showMessage(`Couldn't update notification: ${error.message}`, "error");
          return;
        }
        item.is_read = true;
        item.read_at = new Date().toISOString();
        await renderNotifications();
        showMessage("Notification marked as read.", "success");
      });
      actions.append(mark);
    } else {
      const label = document.createElement("span");
      label.className = "read-label";
      label.textContent = "Read";
      actions.append(label);
    }
    card.append(icon, content, actions);
    return card;
  }
  async function renderNotifications() {
    const list = $("#notifications-list");
    list.replaceChildren();
    const unread = notifications.filter((item) => !item.is_read).length;
    $("#notifications-count").textContent = `${notifications.length} total · ${unread} unread`;
    if (!notifications.length) {
      const empty = document.createElement("div");
      empty.className = "notifications-empty";
      const heading = document.createElement("h3");
      heading.textContent = "You're all caught up";
      const copy = document.createElement("p");
      copy.textContent = "New case, messaging, loan, and payout updates will appear here.";
      empty.append(heading, copy);
      list.append(empty);
      return;
    }
    notifications.forEach((item) => list.append(createNotificationCard(item)));
  }
  async function loadNotifications() {
    const { data, error } = await client.from("user_notifications")
      .select("id, notification_type, title, body, related_claim_id, related_loan_application_id, related_loan_withdrawal_request_id, related_payout_request_id, related_support_ticket_id, is_read, created_at")
      .order("created_at", { ascending: false }).limit(100);
    if (error) {
      showMessage(`Couldn't load notifications: ${error.message}`, "error");
      return;
    }
    notifications = data || [];
    await renderNotifications();
  }
  async function initialize() {
    if (!window.refundSupabaseReady || !client) {
      showMessage("Supabase is not connected. Check js/config.js and js/supabase-client.js.", "error");
      return;
    }
    const { data: { session }, error } = await client.auth.getSession();
    if (error || !session) {
      window.location.href = "../login.html";
      return;
    }
    currentUser = session.user;
    $("#comms-user-email").textContent = currentUser.email || "Signed in";
    $("#comms-sign-out").addEventListener("click", async () => {
      const result = await client.auth.signOut();
      if (result.error) showMessage(`Sign out failed: ${result.error.message}`, "error");
      else window.location.href = "../login.html";
    });
    if (isStaff) {
      const { data: roles, error: roleError } = await client.from("user_roles").select("role").eq("user_id", currentUser.id);
      const allowed = (roles || []).some((row) => ["admin", "super_admin", "support_agent", "investigator"].includes(row.role));
      if (roleError || !allowed) {
        showMessage("Staff access required to open this notification workspace.", "error");
        return;
      }
    }
    $("#mark-all-read").addEventListener("click", async () => {
      const button = $("#mark-all-read");
      button.disabled = true;
      const { error: markError } = await client.rpc("mark_all_notifications_read");
      button.disabled = false;
      if (markError) {
        showMessage(`Couldn't mark notifications as read: ${markError.message}`, "error");
        return;
      }
      notifications.forEach((item) => { item.is_read = true; item.read_at = new Date().toISOString(); });
      await renderNotifications();
      showMessage("All notifications marked as read.", "success");
    });
    await loadNotifications();
    window.setInterval(() => {
      if (document.visibilityState === "visible") loadNotifications();
    }, 45000);
  }
  document.addEventListener("DOMContentLoaded", initialize);
})();
