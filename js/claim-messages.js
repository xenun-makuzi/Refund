(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const workspace = document.body.dataset.workspace || "customer";
  const isStaff = workspace === "staff";
  const client = window.refundSupabase;
  let currentUser = null;
  let claims = [];
  let activeClaim = null;
  let refreshTimer = null;
  let loadingMessages = false;

  const showGlobal = (text, kind = "info") => {
    const box = $("#comms-global-message");
    if (!box) return;
    box.textContent = text;
    box.className = `comms-alert ${kind}`;
    box.hidden = !text;
  };

  const prettyStatus = (value) => String(value || "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

  const formatDate = (value) => {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
    });
  };

  function requireClient() {
    if (!window.refundSupabaseReady || !client) {
      showGlobal("Supabase is not connected. Check js/config.js and js/supabase-client.js, then refresh.", "error");
      return false;
    }
    return true;
  }

  async function loadUnreadCount() {
    const countEl = $("#comms-unread-count");
    if (!countEl) return;
    const { count, error } = await client
      .from("user_notifications")
      .select("id", { count: "exact", head: true })
      .eq("is_read", false);
    countEl.textContent = error ? "—" : String(count || 0);
  }

  function renderClaimList() {
    const list = $("#conversation-list");
    const count = $("#conversation-count");
    list.replaceChildren();
    count.textContent = String(claims.length);

    if (!claims.length) {
      const empty = document.createElement("p");
      empty.className = "comms-muted empty-rail-message";
      empty.textContent = isStaff
        ? "No cases are currently accessible to your role. Investigators see assigned cases; administrators and support can see the queues permitted by their roles."
        : "You don't have any claims yet. Submit a claim first, and its conversation will appear here.";
      list.append(empty);
      return;
    }

    claims.forEach((claim) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `conversation-item${activeClaim?.id === claim.id ? " is-active" : ""}`;
      button.setAttribute("aria-pressed", String(activeClaim?.id === claim.id));
      button.addEventListener("click", () => selectClaim(claim));

      const top = document.createElement("span");
      top.className = "conversation-item-top";
      const ref = document.createElement("strong");
      ref.textContent = claim.case_reference || "Case";
      const status = document.createElement("span");
      status.className = "tiny-status";
      status.textContent = prettyStatus(claim.status);
      top.append(ref, status);

      const title = document.createElement("span");
      title.className = "conversation-item-title";
      title.textContent = claim.title || "Untitled claim";
      const date = document.createElement("span");
      date.className = "conversation-item-date";
      date.textContent = formatDate(claim.updated_at || claim.created_at);
      button.append(top, title, date);
      list.append(button);
    });
  }

  function renderMessages(messages) {
    const list = $("#chat-message-list");
    list.replaceChildren();
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "chat-no-messages";
      const title = document.createElement("strong");
      title.textContent = "Start the conversation";
      const copy = document.createElement("p");
      copy.textContent = isStaff
        ? "Send a clear, customer-visible reply here. Put internal-only information in the case activity notes instead."
        : "Send a message to the Refund team if you have information or questions about this case.";
      empty.append(title, copy);
      list.append(empty);
      return;
    }

    messages.forEach((message) => {
      const own = message.sender_id === currentUser.id;
      const fromCustomer = message.sender_id === activeClaim.user_id;
      const wrapper = document.createElement("article");
      wrapper.className = `chat-message ${own ? "is-own" : "is-other"}`;
      const meta = document.createElement("div");
      meta.className = "chat-message-meta";
      const sender = document.createElement("strong");
      sender.textContent = own ? "You" : (isStaff && fromCustomer ? "Customer" : "Refund team");
      const time = document.createElement("time");
      time.textContent = formatDate(message.created_at);
      if (message.created_at) time.dateTime = message.created_at;
      meta.append(sender, time);
      const body = document.createElement("p");
      body.className = "chat-message-body";
      // Use textContent so message text can never inject HTML or JavaScript.
      body.textContent = message.body;
      wrapper.append(meta, body);
      list.append(wrapper);
    });
    list.scrollTop = list.scrollHeight;
  }

  async function loadMessages(showLoading = false) {
    if (!activeClaim || loadingMessages) return;
    loadingMessages = true;
    const list = $("#chat-message-list");
    if (showLoading) {
      list.replaceChildren();
      const msg = document.createElement("p");
      msg.className = "comms-muted";
      msg.textContent = "Loading messages…";
      list.append(msg);
    }
    const claimAtLoad = activeClaim;
    const { data, error } = await client
      .from("claim_messages")
      .select("id, claim_id, sender_id, body, created_at")
      .eq("claim_id", claimAtLoad.id)
      .order("created_at", { ascending: true })
      .limit(500);
    loadingMessages = false;

    if (activeClaim?.id !== claimAtLoad.id) return;
    if (error) {
      showGlobal(`Couldn't load messages: ${error.message}`, "error");
      return;
    }
    renderMessages(data || []);
  }

  async function selectClaim(claim) {
    activeClaim = claim;
    $("#conversation-empty").hidden = true;
    $("#conversation-active").hidden = false;
    $("#active-claim-title").textContent = claim.title || "Claim conversation";
    $("#active-claim-meta").textContent = `${claim.case_reference} · ${prettyStatus(claim.status)}`;
    $("#active-claim-status").textContent = prettyStatus(claim.status);
    $("#chat-message-input").disabled = false;
    $("#chat-send-button").disabled = false;
    renderClaimList();
    const { error } = await client.rpc("mark_claim_messages_read", { p_claim_id: claim.id });
    if (error) console.warn("Could not mark messages as read:", error.message);
    await loadMessages(true);
    await loadUnreadCount();
    const url = new URL(window.location.href);
    url.searchParams.set("claim", claim.id);
    history.replaceState({}, "", url);
  }

  async function loadClaims() {
    let query = client
      .from("claims")
      .select("id, user_id, case_reference, title, status, assigned_to, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(200);

    if (!isStaff) query = query.eq("user_id", currentUser.id);
    const { data, error } = await query;
    if (error) {
      showGlobal(`Couldn't load cases: ${error.message}`, "error");
      return;
    }
    claims = data || [];
    renderClaimList();
    if (!claims.length) {
      $("#conversation-empty").hidden = false;
      $("#conversation-active").hidden = true;
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const requestedClaim = params.get("claim");
    const requested = requestedClaim && claims.find((claim) => claim.id === requestedClaim);
    await selectClaim(requested || claims[0]);
  }

  async function signOut() {
    const { error } = await client.auth.signOut();
    if (error) showGlobal(`Sign out failed: ${error.message}`, "error");
    else window.location.href = "../login.html";
  }

  async function initialize() {
    if (!requireClient()) return;
    const { data: { session }, error: sessionError } = await client.auth.getSession();
    if (sessionError || !session) {
      window.location.href = "../login.html";
      return;
    }
    currentUser = session.user;
    $("#comms-user-email").textContent = currentUser.email || "Signed in";
    $("#comms-sign-out").addEventListener("click", signOut);

    if (isStaff) {
      const { data: roleRows, error: roleError } = await client
        .from("user_roles")
        .select("role")
        .eq("user_id", currentUser.id);
      const roles = (roleRows || []).map((row) => row.role);
      const allowed = ["admin", "super_admin", "support_agent", "investigator"].some((role) => roles.includes(role));
      if (roleError || !allowed) {
        showGlobal("You don't have a staff role that permits access to the communications workspace.", "error");
        $("#conversation-list").replaceChildren();
        $("#conversation-empty").hidden = false;
        $("#conversation-empty").querySelector("h2").textContent = "Staff access required";
        $("#conversation-empty").querySelector("p").textContent = "Contact your Refund administrator if you believe this is an error.";
        return;
      }
    }

    await loadUnreadCount();
    await loadClaims();
    $("#chat-send-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!activeClaim) return;
      const input = $("#chat-message-input");
      const body = input.value.trim();
      if (!body) return;
      const button = $("#chat-send-button");
      button.disabled = true;
      const { error } = await client.rpc("send_claim_message", {
        p_claim_id: activeClaim.id,
        p_body: body
      });
      button.disabled = false;
      if (error) {
        showGlobal(`Message could not be sent: ${error.message}`, "error");
        return;
      }
      input.value = "";
      showGlobal("Message sent.", "success");
      await loadMessages(true);
      await loadUnreadCount();
    });

    refreshTimer = window.setInterval(async () => {
      await loadUnreadCount();
      if (activeClaim && document.visibilityState === "visible") await loadMessages(false);
    }, 15000);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && activeClaim && client && currentUser) loadMessages(false);
  });
  window.addEventListener("beforeunload", () => {
    if (refreshTimer) window.clearInterval(refreshTimer);
  });
  document.addEventListener("DOMContentLoaded", initialize);
})();
