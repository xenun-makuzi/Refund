(() => {
  "use strict";

  const client = window.refundSupabase;
  const $ = (selector) => document.querySelector(selector);
  const BUCKET = "identity-documents";
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
  let currentUser = null;
  let profile = null;
  let latestSubmission = null;

  const statusLabels = {
    unsubmitted: "Not submitted",
    pending: "Under review",
    verified: "Verified",
    rejected: "Not approved",
    action_required: "Action required"
  };

  function setMessage(text, kind = "info") {
    const box = $("#verification-message");
    box.hidden = !text;
    box.className = `notice${kind === "error" ? " is-error" : kind === "success" ? " is-success" : ""}`;
    box.textContent = text || "";
  }

  function formatDate(value) {
    if (!value) return "Date unavailable";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function labelDocumentType(value) {
    return ({
      passport: "Passport",
      national_id: "National identity card",
      drivers_license: "Driver's license",
      residence_permit: "Residence permit",
      other: "Other government-issued ID"
    })[value] || "Identity document";
  }

  function statusTone(status) {
    if (status === "verified") return "is-success";
    if (status === "rejected") return "is-danger";
    if (status === "action_required" || status === "pending") return "is-warning";
    return "";
  }

  function renderCurrentStatus() {
    const status = profile?.identity_status || "unsubmitted";
    const accountActive = (profile?.account_status || "active") === "active";
    const card = $("#status-card");
    const badge = $("#verification-status-badge");
    const historyNote = $("#verification-review-note");
    const formCard = $("#identity-form-card");
    const form = $("#identity-verification-form");
    const title = $("#verification-status-title");
    const description = $("#verification-status-description");
    const icon = $("#verification-status-icon");

    const copy = {
      unsubmitted: ["Submit an identity document", "Your identity has not been submitted yet. You can start securely using the form below.", "⌑"],
      pending: ["Your document is being reviewed", "Your latest submission is awaiting an authorized review. You don't need to submit it again while this review is pending.", "◷"],
      verified: ["Your identity is verified", "Your submitted document has been approved. Other actions, including payouts, still depend on their own eligibility requirements.", "✓"],
      rejected: ["This submission was not approved", "Review the note below and submit a clearer or appropriate document if the form is available.", "!"],
      action_required: ["More information is needed", "Review the note below, then upload an updated document to continue.", "!" ]
    };
    const content = copy[status] || copy.unsubmitted;
    title.textContent = !accountActive ? "Account access is restricted" : content[0];
    description.textContent = !accountActive
      ? "Identity submissions are unavailable while your account is not active. Contact support for assistance."
      : content[1];
    icon.textContent = !accountActive ? "!" : content[2];
    badge.textContent = !accountActive ? "Restricted" : (statusLabels[status] || statusLabels.unsubmitted);
    badge.className = `status-badge ${!accountActive ? "is-danger" : statusTone(status)}`;
    card.className = `status-card ${!accountActive ? "is-danger" : statusTone(status)}`;

    if (latestSubmission?.review_note && ["rejected", "action_required"].includes(status)) {
      historyNote.hidden = false;
      historyNote.textContent = `Review note: ${latestSubmission.review_note}`;
    } else {
      historyNote.hidden = true;
      historyNote.textContent = "";
    }

    const maySubmit = accountActive && ["unsubmitted", "rejected", "action_required"].includes(status);
    formCard.hidden = !maySubmit;
    if (form) {
      for (const control of form.elements) control.disabled = !maySubmit;
    }
  }

  function renderHistory(rows) {
    const target = $("#verification-history");
    target.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "empty-history";
      empty.textContent = "You haven't submitted an identity document yet.";
      target.append(empty);
      return;
    }
    for (const row of rows) {
      const item = document.createElement("article");
      item.className = "history-row";
      const copy = document.createElement("div");
      copy.className = "history-row-copy";
      const heading = document.createElement("strong");
      heading.textContent = labelDocumentType(row.document_type);
      const detail = document.createElement("span");
      detail.textContent = `Submitted ${formatDate(row.created_at)}`;
      copy.append(heading, detail);
      const badge = document.createElement("span");
      badge.className = `status-badge ${statusTone(row.status)}`;
      badge.textContent = statusLabels[row.status] || row.status;
      item.append(copy, badge);
      target.append(item);
    }
  }

  async function loadPage() {
    if (!window.refundSupabaseReady || !client) {
      setMessage("Supabase is not connected. Check js/config.js and js/supabase-client.js.", "error");
      $("#identity-form-card").hidden = true;
      $("#verification-history").textContent = "Verification status is unavailable until Supabase connects.";
      return;
    }

    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError || !sessionData?.session) {
      window.location.href = "../login.html";
      return;
    }
    currentUser = sessionData.session.user;

    const { data: profileData, error: profileError } = await client
      .from("profiles")
      .select("id, full_name, identity_status, account_status")
      .eq("id", currentUser.id)
      .maybeSingle();

    if (profileError || !profileData) {
      setMessage("We couldn't load your profile. Please refresh or contact support if this continues.", "error");
      $("#identity-form-card").hidden = true;
      return;
    }
    profile = profileData;

    const { data: submissions, error: historyError } = await client
      .from("identity_verification_submissions")
      .select("id, document_type, status, review_note, created_at, reviewed_at")
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: false })
      .limit(5);

    if (historyError) {
      console.error("Identity history load failed:", historyError.message);
      setMessage("Your profile status loaded, but submission history could not be loaded. Use Refresh or contact support.", "error");
    } else {
      latestSubmission = submissions?.[0] || null;
      renderHistory(submissions || []);
    }

    renderCurrentStatus();
  }

  function extensionFor(file) {
    return ({
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "application/pdf": "pdf"
    })[file.type] || "bin";
  }

  function validateFile(file, label, required) {
    if (!file) {
      if (required) throw new Error(`Choose a file for ${label.toLowerCase()}.`);
      return;
    }
    if (!ACCEPTED_TYPES.has(file.type)) {
      throw new Error(`${label} must be a JPG, PNG, WebP, or PDF file.`);
    }
    if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
      throw new Error(`${label} must be larger than 0 bytes and no more than 10 MB.`);
    }
  }

  async function uploadFile(file, side, uploadedPaths) {
    if (!file) return null;
    const path = `${currentUser.id}/${crypto.randomUUID()}-${side}.${extensionFor(file)}`;
    const { error } = await client.storage.from(BUCKET).upload(path, file, {
      cacheControl: "0",
      upsert: false,
      contentType: file.type
    });
    if (error) throw new Error(`The ${side} document could not be uploaded: ${error.message}`);
    uploadedPaths.push(path);
    return path;
  }

  async function submitVerification(event) {
    event.preventDefault();
    const form = $("#identity-verification-form");
    const submit = $("#identity-submit-button");
    const frontFile = $("#document-front").files[0];
    const backFile = $("#document-back").files[0] || null;
    const documentType = $("#document-type").value;
    const consent = $("#identity-consent").checked;
    const uploadedPaths = [];
    let submissionCommitted = false;

    try {
      if (!documentType) throw new Error("Choose the type of identity document.");
      validateFile(frontFile, "Main document", true);
      validateFile(backFile, "Back-side document", false);
      if (!consent) throw new Error("Confirm the document and privacy notice before submitting.");
      if (!profile || !(profile.account_status === "active") || !["unsubmitted", "rejected", "action_required"].includes(profile.identity_status || "unsubmitted")) {
        throw new Error("Your account is not currently eligible to submit another identity document. Refresh your status first.");
      }

      submit.disabled = true;
      submit.classList.add("is-loading");
      setMessage("Uploading your document securely… please keep this page open.");

      const frontPath = await uploadFile(frontFile, "main", uploadedPaths);
      const backPath = backFile ? await uploadFile(backFile, "back", uploadedPaths) : null;
      const { error } = await client.from("identity_verification_submissions").insert({
        user_id: currentUser.id,
        document_type: documentType,
        document_front_path: frontPath,
        document_back_path: backPath,
        status: "pending"
      });

      if (error) {
        if (error.code === "23505") throw new Error("A submission is already awaiting review. Refresh the page to see its current status.");
        throw new Error(error.message || "Your submission could not be saved.");
      }
      submissionCommitted = true;

      form.reset();
      $("#front-file-name").textContent = "No file selected";
      $("#back-file-name").textContent = "No file selected";
      setMessage("Your document has been submitted. Your status is now pending review.", "success");
      await loadPage();
    } catch (error) {
      if (uploadedPaths.length && !submissionCommitted) {
        try { await client.storage.from(BUCKET).remove(uploadedPaths); }
        catch (cleanupError) { console.warn("Could not clean up unattached identity upload:", cleanupError); }
      }
      console.error("Identity submission failed:", error);
      setMessage(error.message || "We couldn't submit your document. Please try again.", "error");
    } finally {
      submit.disabled = false;
      submit.classList.remove("is-loading");
    }
  }

  async function initialize() {
    $("#verification-year").textContent = String(new Date().getFullYear());
    $("#document-front").addEventListener("change", () => {
      $("#front-file-name").textContent = $("#document-front").files[0]?.name || "No file selected";
    });
    $("#document-back").addEventListener("change", () => {
      $("#back-file-name").textContent = $("#document-back").files[0]?.name || "No file selected";
    });
    $("#identity-verification-form").addEventListener("submit", submitVerification);
    $("#verification-sign-out").addEventListener("click", async () => {
      const button = $("#verification-sign-out");
      button.disabled = true;
      const { error } = await client.auth.signOut();
      if (error) {
        button.disabled = false;
        setMessage("We couldn't sign you out. Please try again.", "error");
        return;
      }
      window.location.href = "../login.html";
    });
    await loadPage();
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
