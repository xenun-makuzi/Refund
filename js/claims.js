(() => {
  "use strict";

  const client = window.refundSupabase;
  const $ = (selector) => document.querySelector(selector);

  const elements = {
    userEmail: $("#claims-user-email"),
    signOut: $("#claims-sign-out"),
    pageMessage: $("#claims-page-message"),
    formMessage: $("#claim-form-message"),
    detailMessage: $("#claim-detail-message"),
    directPanel: $("#direct-claim-panel"),
    partnerPanel: $("#partner-referral-panel"),
    partnerStatusDot: $("#partner-status-dot"),
    partnerStatusText: $("#partner-status-text"),
    form: $("#claim-form"),
    submit: $("#claim-submit"),
    category: $("#claim-category"),
    title: $("#claim-title"),
    description: $("#claim-description"),
    descriptionCount: $("#description-count"),
    merchant: $("#claim-merchant"),
    transactionDate: $("#claim-date"),
    amount: $("#claim-amount"),
    currency: $("#claim-currency"),
    currencySymbol: $("#currency-symbol"),
    files: $("#claim-files"),
    totalStat: $("#stat-total"),
    openStat: $("#stat-open"),
    recentStat: $("#stat-recent"),
    listLoading: $("#claims-list-loading"),
    listEmpty: $("#claims-list-empty"),
    emptyDescription: $("#claims-empty-description"),
    list: $("#claims-list"),
    refresh: $("#refresh-claims"),
    detailPanel: $("#claim-detail-panel"),
    detailHeading: $("#claim-detail-heading"),
    detailSubtitle: $("#claim-detail-subtitle"),
    timeline: $("#claim-timeline"),
    evidenceList: $("#claim-evidence-list"),
    closeDetails: $("#close-claim-details"),
    addEvidenceButton: $("#add-evidence-button"),
    addEvidenceFiles: $("#add-evidence-files"),
    year: $("#current-year")
  };

  const acceptedMimeTypes = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp"
  ]);
  const maxFileSize = 10 * 1024 * 1024;
  const currencySymbols = { USD: "$", EUR: "€", GBP: "£", CAD: "CA$", AUD: "A$" };
  const categoryLabels = {
    purchase_refund: "Purchase refund",
    scam_recovery: "Scam-related recovery",
    tax_refund: "Tax refund",
    service_dispute: "Service dispute",
    other: "Other"
  };
  const statusLabels = {
    submitted: "Submitted",
    under_review: "Under review",
    awaiting_information: "Awaiting information",
    investigation_in_progress: "Investigation in progress",
    recovery_in_progress: "Recovery in progress",
    partially_recovered: "Partially recovered",
    recovery_complete: "Recovery complete",
    not_eligible: "Not eligible",
    closed: "Closed"
  };
  const activityLabels = {
    claim_submitted: "Claim submitted",
    status_change: "Status update",
    message: "Message from the team",
    claim_assigned: "Case assignment",
    evidence_uploaded: "Evidence added",
    system: "Case update"
  };

  let currentUser = null;
  let currentProfile = null;
  let selectedClaim = null;
  let claimCache = [];

  function setMessage(element, text, kind = "info") {
    if (!element) return;
    element.hidden = false;
    element.className = `form-message is-${kind}${element === elements.pageMessage ? " claims-global-message" : element === elements.formMessage ? " claim-form-message" : ""}`;
    element.textContent = text;
  }

  function clearMessage(element) {
    if (!element) return;
    element.hidden = true;
    element.textContent = "";
    element.className = "form-message";
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function formatDate(value, includeTime = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, includeTime
      ? { dateStyle: "medium", timeStyle: "short" }
      : { dateStyle: "medium" }).format(date);
  }

  function formatMoney(amount, currency) {
    if (amount === null || amount === undefined || amount === "") return null;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: (currency || "USD").trim(),
        maximumFractionDigits: 2
      }).format(Number(amount));
    } catch {
      return `${currency || "USD"} ${Number(amount).toFixed(2)}`;
    }
  }

  function prettyStatus(status) {
    return statusLabels[status] || String(status || "Unknown").replaceAll("_", " ");
  }

  function statusClass(status) {
    if (["recovery_complete"].includes(status)) return "status-complete";
    if (["closed", "not_eligible"].includes(status)) return "status-closed";
    if (["awaiting_information"].includes(status)) return "status-awaiting";
    if (["under_review", "investigation_in_progress", "recovery_in_progress", "partially_recovered"].includes(status)) return "status-progress";
    return "status-submitted";
  }

  function categoryLabel(category) {
    return categoryLabels[category] || "Claim";
  }

  function setFormLoading(loading) {
    if (!elements.submit) return;
    elements.submit.disabled = loading;
    elements.submit.classList.toggle("is-loading", loading);
    elements.submit.setAttribute("aria-busy", String(loading));
    const label = elements.submit.querySelector(".button-label");
    if (label) label.textContent = loading ? "Submitting securely…" : "Submit claim securely";
  }

  function validateEvidenceFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (!acceptedMimeTypes.has(file.type)) {
        return `“${file.name}” is not an allowed file type. Use PDF, JPG, PNG, or WEBP.`;
      }
      if (file.size < 1 || file.size > maxFileSize) {
        return `“${file.name}” must be a non-empty file of 10 MB or less.`;
      }
      if (file.name.length > 255) {
        return `“${file.name}” has a filename longer than the platform accepts.`;
      }
    }
    return null;
  }

  async function uploadEvidenceFiles(claim, fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return { uploaded: 0, failures: [] };

    const validationError = validateEvidenceFiles(files);
    if (validationError) throw new Error(validationError);

    let uploaded = 0;
    const failures = [];

    for (const file of files) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "evidence";
      const objectPath = `${currentUser.id}/${claim.id}/${crypto.randomUUID()}-${safeName}`;

      const { error: uploadError } = await client.storage
        .from("claim-evidence")
        .upload(objectPath, file, { contentType: file.type, upsert: false });

      if (uploadError) {
        failures.push({ file: file.name, reason: uploadError.message || "Storage upload failed" });
        continue;
      }

      const { error: metadataError } = await client.from("claim_evidence").insert({
        claim_id: claim.id,
        uploaded_by: currentUser.id,
        storage_path: objectPath,
        original_filename: file.name,
        mime_type: file.type,
        byte_size: file.size,
        document_type: "supporting_document"
      });

      if (metadataError) {
        // Attempt best-effort cleanup. Whether this succeeds depends on the deployed
        // Storage DELETE policy; the file remains private if cleanup is denied.
        try {
          await client.storage.from("claim-evidence").remove([objectPath]);
        } catch (cleanupError) {
          console.warn("Best-effort cleanup of unregistered evidence failed.", cleanupError);
        }
        failures.push({ file: file.name, reason: metadataError.message || "Evidence record could not be saved" });
        continue;
      }
      uploaded += 1;
    }
    return { uploaded, failures };
  }

  function createClaimCard(claim) {
    const article = make("article", "claim-row");
    const main = make("div", "claim-row-main");
    const topLine = make("div", "claim-row-topline");
    topLine.append(
      make("span", "claim-reference", claim.case_reference),
      make("span", `claim-status-pill ${statusClass(claim.status)}`, prettyStatus(claim.status))
    );
    const title = make("h3", "", claim.title);
    const meta = make("div", "claim-row-meta");
    meta.append(
      make("span", "", categoryLabel(claim.category)),
      make("span", "", `Submitted ${formatDate(claim.created_at)}`)
    );
    if (claim.merchant_name) meta.append(make("span", "", claim.merchant_name));
    main.append(topLine, title, meta);

    const side = make("div", "claim-row-side");
    const money = formatMoney(claim.requested_amount, claim.currency);
    side.append(make("span", `claim-row-amount${money ? "" : " is-empty"}`, money || "Amount not provided"));
    const viewButton = make("button", "view-claim-button", "View updates →");
    viewButton.type = "button";
    viewButton.addEventListener("click", () => openClaimDetails(claim));
    side.append(viewButton);
    article.append(main, side);
    return article;
  }

  function updateStats(claims) {
    const closedStates = new Set(["recovery_complete", "not_eligible", "closed"]);
    const openCount = claims.filter((claim) => !closedStates.has(claim.status)).length;
    const now = Date.now();
    const recentCount = claims.filter((claim) => {
      const created = new Date(claim.created_at).getTime();
      return Number.isFinite(created) && now - created <= 30 * 24 * 60 * 60 * 1000;
    }).length;
    if (elements.totalStat) elements.totalStat.textContent = String(claims.length);
    if (elements.openStat) elements.openStat.textContent = String(openCount);
    if (elements.recentStat) elements.recentStat.textContent = String(recentCount);
  }

  async function loadClaims({ silent = false } = {}) {
    if (!currentUser) return;
    if (elements.listLoading) elements.listLoading.hidden = false;
    if (elements.list) elements.list.replaceChildren();
    if (elements.listEmpty) elements.listEmpty.hidden = true;
    if (elements.refresh) elements.refresh.disabled = true;

    try {
      const { data, error } = await client
        .from("claims")
        .select("id, case_reference, category, title, description, merchant_name, transaction_date, requested_amount, currency, origin, status, created_at, updated_at")
        .eq("user_id", currentUser.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      claimCache = data || [];
      updateStats(claimCache);

      if (elements.listLoading) elements.listLoading.hidden = true;
      if (claimCache.length === 0) {
        if (elements.listEmpty) elements.listEmpty.hidden = false;
        if (elements.emptyDescription) {
          elements.emptyDescription.textContent = currentProfile?.onboarding_source === "partner_referral"
            ? "When a claim is linked to your account through the partner process, its reference and updates will appear here. You do not need to submit a generic claim form."
            : "When you submit your first claim, its reference and status will appear here.";
        }
      } else {
        if (elements.listEmpty) elements.listEmpty.hidden = true;
        const fragment = document.createDocumentFragment();
        claimCache.forEach((claim) => fragment.append(createClaimCard(claim)));
        elements.list.append(fragment);
      }

      if (selectedClaim) {
        const latestSelection = claimCache.find((claim) => claim.id === selectedClaim.id);
        if (latestSelection) selectedClaim = latestSelection;
      }
    } catch (error) {
      console.error("Could not load claims:", error);
      if (elements.listLoading) {
        elements.listLoading.hidden = false;
        elements.listLoading.textContent = "We couldn't load your claims. Check your connection and refresh.";
      }
      if (!silent) setMessage(elements.pageMessage, "Your claims could not be loaded. Confirm migration 002 succeeded and that you're signed in to the Refund project.", "error");
    } finally {
      if (elements.refresh) elements.refresh.disabled = false;
    }
  }

  async function loadPartnerStatus() {
    if (currentProfile?.onboarding_source !== "partner_referral") return;
    if (elements.partnerPanel) elements.partnerPanel.hidden = false;
    if (elements.directPanel) elements.directPanel.hidden = true;

    const { data, error } = await client
      .from("partner_referral_submissions")
      .select("status, claimed_partner_name")
      .eq("user_id", currentUser.id)
      .maybeSingle();

    if (error) {
      console.warn("Could not load partner referral status:", error.message);
      if (elements.partnerStatusText) elements.partnerStatusText.textContent = "Your partner referral is on file; its review status could not be loaded.";
      return;
    }

    if (!data) {
      if (elements.partnerStatusText) elements.partnerStatusText.textContent = "No referral record is linked yet. Contact support or your referring organization for assistance.";
      return;
    }

    const labels = {
      pending_review: `Referral from ${data.claimed_partner_name} is awaiting verification.`,
      verified: `Referral from ${data.claimed_partner_name} is verified. A claim appears here once it is linked to your account.`,
      rejected: "The referral could not be verified. Contact support or the referring organization for next steps."
    };
    if (elements.partnerStatusText) elements.partnerStatusText.textContent = labels[data.status] || "Referral status is available.";
    if (elements.partnerStatusDot) {
      elements.partnerStatusDot.classList.toggle("is-verified", data.status === "verified");
      elements.partnerStatusDot.classList.toggle("is-rejected", data.status === "rejected");
    }
  }

  async function loadActivity(claim) {
    if (elements.timeline) elements.timeline.replaceChildren(make("p", "muted-copy", "Loading case activity…"));
    const { data, error } = await client
      .from("claim_activity")
      .select("id, activity_type, visibility, body, created_at")
      .eq("claim_id", claim.id)
      .eq("visibility", "customer")
      .order("created_at", { ascending: true });

    if (error) {
      console.warn("Could not load claim activity:", error.message);
      elements.timeline.replaceChildren(make("p", "muted-copy", "Case updates could not be loaded. Please refresh and try again."));
      return;
    }

    if (!data || data.length === 0) {
      elements.timeline.replaceChildren(make("p", "muted-copy", "No customer-visible updates have been recorded yet."));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of data) {
      const row = make("article", "timeline-item");
      const mark = make("span", "timeline-mark", "•");
      const body = make("div", "timeline-body");
      body.append(
        make("p", "timeline-title", activityLabels[item.activity_type] || "Case update"),
        make("p", "timeline-copy", item.body),
        make("time", "timeline-date", formatDate(item.created_at, true))
      );
      row.append(mark, body);
      fragment.append(row);
    }
    elements.timeline.replaceChildren(fragment);
  }

  async function loadEvidence(claim) {
    if (elements.evidenceList) elements.evidenceList.replaceChildren(make("p", "muted-copy", "Loading documents…"));
    const { data, error } = await client
      .from("claim_evidence")
      .select("id, storage_path, original_filename, mime_type, byte_size, document_type, review_status, created_at")
      .eq("claim_id", claim.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("Could not load evidence metadata:", error.message);
      elements.evidenceList.replaceChildren(make("p", "muted-copy", "Document records could not be loaded."));
      return;
    }

    if (!data || data.length === 0) {
      elements.evidenceList.replaceChildren(make("p", "muted-copy", "No documents have been uploaded for this claim."));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const file of data) {
      const row = make("div", "evidence-row");
      const extension = file.original_filename.split(".").pop().toUpperCase().slice(0, 4);
      const icon = make("span", "evidence-file-icon", extension || "FILE");
      const copy = make("div", "evidence-file-copy");
      copy.append(
        make("strong", "", file.original_filename),
        make("small", "", `${formatBytes(file.byte_size)} · ${reviewStatusLabel(file.review_status)}`)
      );
      const open = make("button", "evidence-open-button", "Open");
      open.type = "button";
      open.addEventListener("click", async () => {
        open.disabled = true;
        open.textContent = "Opening…";
        // Open the tab during the direct click gesture to reduce popup-blocker issues.
        const viewer = window.open("about:blank", "_blank");
        try {
          const { data: signed, error: urlError } = await client.storage
            .from("claim-evidence")
            .createSignedUrl(file.storage_path, 120);
          if (urlError || !signed?.signedUrl) throw urlError || new Error("Could not create a document link.");
          if (viewer) {
            viewer.opener = null;
            viewer.location.href = signed.signedUrl;
          } else {
            throw new Error("Your browser blocked the document tab. Allow pop-ups for this local site and try again.");
          }
        } catch (openError) {
          if (viewer && !viewer.closed) viewer.close();
          setMessage(elements.detailMessage, "We couldn't open this document. Allow pop-ups for this local site, then retry. Check your connection and access permissions.", "error");
        } finally {
          open.disabled = false;
          open.textContent = "Open";
        }
      });
      row.append(icon, copy, open);
      fragment.append(row);
    }
    elements.evidenceList.replaceChildren(fragment);
  }

  function formatBytes(size) {
    if (!Number.isFinite(Number(size))) return "File size unavailable";
    const bytes = Number(size);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function reviewStatusLabel(status) {
    const labels = {
      pending: "Awaiting document review",
      accepted: "Accepted",
      rejected: "Rejected",
      action_required: "Action required"
    };
    return labels[status] || "Review status unavailable";
  }

  async function openClaimDetails(claim) {
    selectedClaim = claim;
    clearMessage(elements.detailMessage);
    if (elements.detailPanel) elements.detailPanel.hidden = false;
    if (elements.detailHeading) elements.detailHeading.textContent = claim.title;
    if (elements.detailSubtitle) elements.detailSubtitle.textContent = `${claim.case_reference} · ${prettyStatus(claim.status)} · Submitted ${formatDate(claim.created_at)}`;
    await Promise.all([loadActivity(claim), loadEvidence(claim)]);
    elements.detailPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    clearMessage(elements.formMessage);
    clearMessage(elements.pageMessage);

    if (currentProfile?.onboarding_source === "partner_referral") {
      setMessage(elements.formMessage, "Your account uses the partner referral path. You do not need to submit a generic claim form.", "warning");
      return;
    }

    if (currentProfile?.account_status !== "active") {
      setMessage(elements.formMessage, "Your account is not currently active, so a new claim cannot be submitted. Contact support for assistance.", "error");
      return;
    }

    const title = elements.title.value.trim();
    const description = elements.description.value.trim();
    const amountText = elements.amount.value.trim();
    const files = Array.from(elements.files.files || []);

    if (title.length < 5 || title.length > 180) {
      setMessage(elements.formMessage, "Enter a claim title between 5 and 180 characters.", "error");
      elements.title.focus();
      return;
    }
    if (description.length < 20 || description.length > 10000) {
      setMessage(elements.formMessage, "Describe what happened in at least 20 characters (maximum 10,000).", "error");
      elements.description.focus();
      return;
    }
    if (amountText !== "" && (!Number.isFinite(Number(amountText)) || Number(amountText) < 0)) {
      setMessage(elements.formMessage, "Enter a valid non-negative amount, or leave the amount blank.", "error");
      elements.amount.focus();
      return;
    }
    const fileValidation = validateEvidenceFiles(files);
    if (fileValidation) {
      setMessage(elements.formMessage, fileValidation, "error");
      elements.files.focus();
      return;
    }

    setFormLoading(true);
    try {
      const payload = {
        user_id: currentUser.id,
        category: elements.category.value,
        title,
        description,
        merchant_name: elements.merchant.value.trim() || null,
        transaction_date: elements.transactionDate.value || null,
        requested_amount: amountText === "" ? null : Number(amountText),
        currency: elements.currency.value
      };

      const { data: claim, error } = await client
        .from("claims")
        .insert(payload)
        .select("id, case_reference, category, title, description, merchant_name, transaction_date, requested_amount, currency, origin, status, created_at, updated_at")
        .single();

      if (error) throw error;
      if (!claim?.id) throw new Error("Claim submission could not be confirmed. Refresh your claims list before trying again.");

      let evidenceResult = { uploaded: 0, failures: [] };
      if (files.length) {
        try {
          evidenceResult = await uploadEvidenceFiles(claim, files);
        } catch (uploadError) {
          evidenceResult = { uploaded: 0, failures: files.map((file) => ({ file: file.name, reason: uploadError.message })) };
        }
      }

      elements.form.reset();
      if (elements.descriptionCount) elements.descriptionCount.textContent = "0 / 10000";
      if (elements.currencySymbol) elements.currencySymbol.textContent = currencySymbols[elements.currency.value] || "$";
      await loadClaims({ silent: true });
      setMessage(elements.pageMessage, `Your claim has been submitted successfully. Reference: ${claim.case_reference}.`, "success");

      if (evidenceResult.failures.length) {
        const names = evidenceResult.failures.map((item) => item.file).join(", ");
        setMessage(elements.formMessage, `Claim ${claim.case_reference} was created, but some documents were not attached: ${names}. Don't submit the claim again; open its details below and use “Add documents” to retry.`, "warning");
      } else if (files.length) {
        setMessage(elements.formMessage, `Claim submitted. ${evidenceResult.uploaded} document(s) uploaded successfully.`, "success");
      } else {
        clearMessage(elements.formMessage);
      }

      const refreshed = claimCache.find((item) => item.id === claim.id) || claim;
      await openClaimDetails(refreshed);
    } catch (error) {
      console.error("Claim submission failed:", error);
      setMessage(elements.formMessage, userFacingError(error), "error");
    } finally {
      setFormLoading(false);
    }
  }

  function userFacingError(error) {
    const message = String(error?.message || "");
    if (/row-level security|permission denied|42501/i.test(message)) {
      return "The database rejected this action. Confirm that migration 002 succeeded, you are signed in to the correct Refund project, and the claim policies are installed.";
    }
    if (/network|fetch|failed to fetch/i.test(message)) {
      return "The request could not reach Supabase. Check your connection and project configuration, then try again.";
    }
    if (/violates check constraint|invalid input/i.test(message)) {
      return "Some claim details did not pass validation. Check the fields and try again.";
    }
    return "We couldn't submit the claim. Please check the information and try again. If the issue continues, contact support.";
  }

  async function handleAddEvidence(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!selectedClaim || !files.length) return;
    clearMessage(elements.detailMessage);

    const validationError = validateEvidenceFiles(files);
    if (validationError) {
      setMessage(elements.detailMessage, validationError, "error");
      return;
    }

    elements.addEvidenceButton.disabled = true;
    elements.addEvidenceButton.textContent = "Uploading…";
    try {
      const result = await uploadEvidenceFiles(selectedClaim, files);
      if (result.failures.length) {
        const names = result.failures.map((item) => item.file).join(", ");
        setMessage(elements.detailMessage, `${result.uploaded} document(s) uploaded. These files could not be attached: ${names}. You can retry them.`, "warning");
      } else {
        setMessage(elements.detailMessage, `${result.uploaded} document(s) uploaded successfully.`, "success");
      }
      await loadEvidence(selectedClaim);
      await loadActivity(selectedClaim);
    } catch (error) {
      console.error("Additional evidence upload failed:", error);
      setMessage(elements.detailMessage, "Documents could not be uploaded. Check your connection, file types, and file sizes, then try again.", "error");
    } finally {
      elements.addEvidenceButton.disabled = false;
      elements.addEvidenceButton.textContent = "+ Add documents";
    }
  }

  async function initialize() {
    if (elements.year) elements.year.textContent = String(new Date().getFullYear());

    if (!window.refundSupabaseReady || !client) {
      setMessage(elements.pageMessage, "Supabase is not connected. Check js/config.js and reload this page.", "error");
      if (elements.listLoading) elements.listLoading.textContent = "The claims workspace is not connected.";
      if (elements.form) elements.form.querySelectorAll("input, select, textarea, button").forEach((el) => { el.disabled = true; });
      return;
    }

    try {
      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError || !userData?.user) {
        window.location.replace("../login.html");
        return;
      }
      currentUser = userData.user;
      if (elements.userEmail) elements.userEmail.textContent = currentUser.email || "Signed-in customer";

      const { data: profile, error: profileError } = await client
        .from("profiles")
        .select("id, full_name, onboarding_source, identity_status, account_status")
        .eq("id", currentUser.id)
        .single();

      if (profileError || !profile) {
        console.error("Could not load customer profile:", profileError);
        setMessage(elements.pageMessage, "Your signed-in account does not have a readable customer profile yet. Ask the administrator to verify the profile migration before submitting a claim.", "error");
        if (elements.form) elements.form.querySelectorAll("input, select, textarea, button").forEach((el) => { el.disabled = true; });
        return;
      }
      currentProfile = profile;

      // Partner-referred claims may have been created before this customer registered.
      // Link eligible pre-created claims on this page too (not only on the dashboard).
      // The RPC enforces confirmed email + verified partner + exact invited-email match.
      if (currentProfile.onboarding_source === "partner_referral") {
        const { data: linkedCount, error: linkError } = await client.rpc(
          "claim_partner_referrals_for_current_user"
        );
        if (linkError) {
          console.error("Could not link partner referral claims:", linkError);
          setMessage(
            elements.pageMessage,
            "Your referral was found, but we couldn't finish matching any pre-created claims. Please refresh or contact support if your case still doesn't appear.",
            "warning"
          );
        } else if (Number(linkedCount) > 0) {
          console.info(`Linked ${linkedCount} partner claim(s) to the signed-in customer.`);
        }
      }

      if (currentProfile.account_status !== "active") {
        setMessage(elements.pageMessage, "Your account is currently inactive or suspended. You can review existing claims, but new submissions are disabled. Contact support if you believe this is an error.", "warning");
        if (elements.form) elements.form.querySelectorAll("input, select, textarea, button").forEach((el) => { el.disabled = true; });
      }

      if (currentProfile.onboarding_source === "partner_referral") {
        await loadPartnerStatus();
      } else {
        if (elements.partnerPanel) elements.partnerPanel.hidden = true;
        if (elements.directPanel) elements.directPanel.hidden = false;
      }

      await loadClaims();
    } catch (error) {
      console.error("Could not initialize claims workspace:", error);
      setMessage(elements.pageMessage, "The workspace could not load. Refresh the page; if it continues, check the browser console for the technical error.", "error");
    }
  }

  function updateCurrencySymbol() {
    if (elements.currencySymbol && elements.currency) {
      elements.currencySymbol.textContent = currencySymbols[elements.currency.value] || elements.currency.value;
    }
  }

  function updateDescriptionCount() {
    if (elements.descriptionCount && elements.description) {
      elements.descriptionCount.textContent = `${elements.description.value.length} / 10000`;
    }
  }

  elements.form?.addEventListener("submit", handleSubmit);
  elements.refresh?.addEventListener("click", () => loadClaims());
  elements.currency?.addEventListener("change", updateCurrencySymbol);
  elements.description?.addEventListener("input", updateDescriptionCount);
  elements.closeDetails?.addEventListener("click", () => {
    elements.detailPanel.hidden = true;
    selectedClaim = null;
  });
  elements.addEvidenceButton?.addEventListener("click", () => {
    if (!selectedClaim) {
      setMessage(elements.detailMessage, "Open one of your claims first.", "warning");
      return;
    }
    elements.addEvidenceFiles.click();
  });
  elements.addEvidenceFiles?.addEventListener("change", handleAddEvidence);
  elements.signOut?.addEventListener("click", async () => {
    elements.signOut.disabled = true;
    try {
      const { error } = await client.auth.signOut();
      if (error) throw error;
      window.location.replace("../login.html");
    } catch (error) {
      console.error("Sign out failed:", error);
      setMessage(elements.pageMessage, "We couldn't sign you out right now. Check your connection and try again.", "error");
      elements.signOut.disabled = false;
    }
  });

  initialize();
})();
