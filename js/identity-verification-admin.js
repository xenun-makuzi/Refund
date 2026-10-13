(() => {
  "use strict";

  const client = window.refundSupabase;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const BUCKET = "identity-documents";
  let signedInUser = null;
  let requestInProgress = false;

  const labels = {
    passport: "Passport",
    national_id: "National identity card",
    drivers_license: "Driver's license",
    residence_permit: "Residence permit",
    other: "Other government-issued ID",
    pending: "Pending review",
    verified: "Verified",
    rejected: "Not approved",
    action_required: "Action required"
  };

  function message(text, kind = "info") {
    const box = $("#identity-admin-message");
    box.hidden = !text;
    box.className = `identity-admin-notice${kind === "error" ? " is-error" : kind === "success" ? " is-success" : ""}`;
    box.textContent = text || "";
  }

  function formatDate(value) {
    if (!value) return "Date unavailable";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function statusLabel(value) {
    return labels[value] || String(value || "Unknown").replaceAll("_", " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function renderCount(rows, key, value) {
    const el = $(key);
    if (el) el.textContent = String(value);
  }

  function renderQueue(rows) {
    const target = $("#identity-submissions-list");
    target.replaceChildren();

    if (!rows.length) {
      const empty = make("div", "identity-empty", "No submissions match this filter.");
      target.append(empty);
      return;
    }

    for (const item of rows) {
      const card = make("article", "identity-submission-card");
      card.dataset.submissionId = item.submission_id;

      const top = make("div", "submission-top");
      const person = make("div", "submission-person");
      person.append(
        make("h3", "", item.full_name || "Customer"),
        make("p", "", item.user_email || item.user_id || "Email unavailable")
      );
      const status = make("span", `submission-status ${item.status || ""}`, statusLabel(item.status));
      top.append(person, status);
      card.append(top);

      const meta = make("div", "submission-meta");
      meta.append(
        make("span", "submission-tag", statusLabel(item.document_type)),
        make("span", "submission-tag", `Submitted ${formatDate(item.submitted_at)}`)
      );
      if (item.reviewed_at) meta.append(make("span", "submission-tag", `Reviewed ${formatDate(item.reviewed_at)}`));
      card.append(meta);

      const documents = make("div", "submission-documents");
      const frontButton = make("button", "doc-view-button", "View main document ↗");
      frontButton.type = "button";
      frontButton.addEventListener("click", () => openDocument(item.document_front_path, frontButton));
      documents.append(frontButton);
      if (item.document_back_path) {
        const backButton = make("button", "doc-view-button", "View back side ↗");
        backButton.type = "button";
        backButton.addEventListener("click", () => openDocument(item.document_back_path, backButton));
        documents.append(backButton);
      }
      card.append(documents);

      if (item.review_note) card.append(make("div", "review-note-preview", `Previous review note: ${item.review_note}`));

      if (item.status === "pending") {
        const form = make("form", "review-form");
        form.noValidate = true;
        const noteLabel = make("label", "", "Review note (required for rejection or additional information)");
        const note = make("textarea");
        note.rows = 3;
        note.maxLength = 2000;
        note.placeholder = "Explain the decision clearly. Do not include unnecessary sensitive details.";
        noteLabel.append(note);
        const actions = make("div", "review-actions");
        const approve = make("button", "", "Approve & verify");
        approve.type = "button";
        approve.dataset.decision = "verified";
        const needInfo = make("button", "", "Request update");
        needInfo.type = "button";
        needInfo.dataset.decision = "action_required";
        const reject = make("button", "", "Reject");
        reject.type = "button";
        reject.dataset.decision = "rejected";
        actions.append(approve, needInfo, reject);
        form.append(noteLabel, actions);
        for (const button of $$('button[data-decision]', form)) {
          button.addEventListener("click", () => reviewSubmission(item, button.dataset.decision, note, form));
        }
        card.append(form);
      } else {
        card.append(make("p", "muted", "This submission has already been reviewed. It is read-only here."));
      }

      target.append(card);
    }
  }

  async function openDocument(path, button) {
    if (!path) {
      message("No file path is available for this document.", "error");
      return;
    }
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      message("Your browser blocked the document preview. Allow pop-ups for this local site and try again.", "error");
      return;
    }
    try { tab.opener = null; } catch { /* best effort */ }
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Preparing secure link…";
    try {
      const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, 60);
      if (error || !data?.signedUrl) throw new Error(error?.message || "A secure preview link could not be created.");
      tab.location.href = data.signedUrl;
      message("A short-lived private document link was opened. Treat the file as confidential.", "success");
    } catch (error) {
      tab.close();
      console.error("Identity document preview failed:", error);
      message("We couldn't open that document. Confirm that the private storage policy is installed and try again.", "error");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function reviewSubmission(item, decision, noteField, form) {
    if (requestInProgress) return;
    const note = noteField.value.trim();
    if (["rejected", "action_required"].includes(decision) && note.length < 5) {
      noteField.focus();
      message("Add a clear review note of at least five characters for this decision.", "error");
      return;
    }
    const confirmed = window.confirm(
      decision === "verified"
        ? `Confirm that the identity document for ${item.full_name || item.user_email} has been reviewed and can be marked verified?`
        : decision === "rejected"
          ? `Reject this identity submission for ${item.full_name || item.user_email}? The customer will receive a status notification.`
          : `Request additional information from ${item.full_name || item.user_email}? The customer will receive a status notification.`
    );
    if (!confirmed) return;

    requestInProgress = true;
    const buttons = $$('button[data-decision]', form);
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const { error } = await client.rpc("review_identity_submission", {
        p_submission_id: item.submission_id,
        p_status: decision,
        p_review_note: note || null
      });
      if (error) throw error;
      message(`Submission marked ${statusLabel(decision).toLowerCase()}. Customer profile and audit history have been updated.`, "success");
      requestInProgress = false;
      await loadQueue();
    } catch (error) {
      console.error("Identity review action failed:", error);
      message(error.message || "The review decision could not be saved.", "error");
      buttons.forEach((button) => { button.disabled = false; });
    } finally {
      requestInProgress = false;
    }
  }

  async function fetchStatus(status) {
    const { data, error } = await client.rpc("admin_list_identity_submissions", { p_status: status });
    if (error) throw error;
    return data || [];
  }

  async function loadQueue() {
    if (requestInProgress) return;
    const button = $("#identity-admin-refresh");
    button.disabled = true;
    button.textContent = "Refreshing…";
    const filter = $("#identity-status-filter").value;
    try {
      const [rows, pending, actionRequired, verified] = await Promise.all([
        fetchStatus(filter),
        fetchStatus("pending"),
        fetchStatus("action_required"),
        fetchStatus("verified")
      ]);
      renderQueue(rows);
      renderCount(pending, "#identity-stat-pending", pending.length);
      renderCount(actionRequired, "#identity-stat-action", actionRequired.length);
      renderCount(verified, "#identity-stat-verified", verified.length);
      if (!rows.length) message("The queue loaded successfully. No submissions match the selected status.");
      else message(`Loaded ${rows.length} submission${rows.length === 1 ? "" : "s"}. Open a document only when needed for your review.`);
    } catch (error) {
      console.error("Identity review queue failed:", error);
      $("#identity-submissions-list").replaceChildren(make("div", "identity-empty", "The identity queue could not be loaded. Check that migration 009 succeeded and your account has administrator access."));
      message(error.message || "The identity review queue could not be loaded.", "error");
    } finally {
      button.disabled = false;
      button.textContent = "↻ Refresh queue";
    }
  }

  async function initialize() {
    if (!window.refundSupabaseReady || !client) {
      message("Supabase is not connected. Check js/config.js and js/supabase-client.js.", "error");
      return;
    }
    const { data: session, error: sessionError } = await client.auth.getSession();
    if (sessionError || !session?.session) {
      window.location.href = "../login.html";
      return;
    }
    signedInUser = session.session.user;
    const { data: roles, error: rolesError } = await client.from("user_roles").select("role").eq("user_id", signedInUser.id);
    if (rolesError || !(roles || []).some((row) => ["admin", "super_admin"].includes(row.role))) {
      window.location.href = "../customer/dashboard.html";
      return;
    }
    const { data: profile } = await client.from("profiles").select("full_name").eq("id", signedInUser.id).maybeSingle();
    $("#identity-admin-name").textContent = profile?.full_name || signedInUser.email || "Administrator";
    $("#identity-admin-role").textContent = (roles || []).some((row) => row.role === "super_admin") ? "Super administrator" : "Administrator";
    $("#identity-admin-signout").addEventListener("click", async () => {
      const signout = $("#identity-admin-signout");
      signout.disabled = true;
      const { error } = await client.auth.signOut();
      if (error) {
        signout.disabled = false;
        message("We couldn't sign you out. Please try again.", "error");
        return;
      }
      window.location.href = "../login.html";
    });
    $("#identity-admin-refresh").addEventListener("click", loadQueue);
    $("#identity-status-filter").addEventListener("change", loadQueue);
    await loadQueue();
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
