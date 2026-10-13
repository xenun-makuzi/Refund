(() => {
  const form = document.querySelector("#register-form");
  const fullNameInput = document.querySelector("#full-name");
  const emailInput = document.querySelector("#register-email");
  const passwordInput = document.querySelector("#register-password");
  const confirmPasswordInput = document.querySelector("#confirm-password");
  const partnerNameInput = document.querySelector("#partner-name");
  const partnerCodeInput = document.querySelector("#partner-code");
  const partnerFields = document.querySelector("#partner-fields");
  const submitButton = document.querySelector("#register-submit");
  const message = document.querySelector("#register-message");
  const togglePassword = document.querySelector("#toggle-register-password");
  const year = document.querySelector("#current-year");
  const client = window.refundSupabase;

  if (year) year.textContent = String(new Date().getFullYear());

  function showMessage(text, kind = "info") {
    if (!message) return;
    message.hidden = false;
    message.className = `form-message is-${kind}`;
    message.textContent = text;
  }

  function setLoading(isLoading) {
    if (!submitButton) return;
    submitButton.disabled = isLoading;
    submitButton.classList.toggle("is-loading", isLoading);
    submitButton.setAttribute("aria-busy", String(isLoading));
    const label = submitButton.querySelector(".button-label");
    if (label) label.textContent = isLoading ? "Creating your account…" : "Create account";
  }

  function getSource() {
    return form?.querySelector('input[name="onboarding-source"]:checked')?.value === "partner_referral"
      ? "partner_referral"
      : "direct";
  }

  function updateSourceFields() {
    const isPartner = getSource() === "partner_referral";
    if (partnerFields) partnerFields.hidden = !isPartner;
    if (partnerNameInput) {
      partnerNameInput.disabled = !isPartner;
      partnerNameInput.required = isPartner;
    }
    if (partnerCodeInput) partnerCodeInput.disabled = !isPartner;
  }

  // The homepage can deep-link here with ?source=direct or ?source=partner.
  const requestedSource = new URLSearchParams(window.location.search).get("source");
  if (requestedSource === "partner") {
    const partnerRadio = document.querySelector("#source-partner");
    if (partnerRadio) partnerRadio.checked = true;
  } else if (requestedSource === "direct") {
    const directRadio = document.querySelector("#source-direct");
    if (directRadio) directRadio.checked = true;
  }
  form?.querySelectorAll('input[name="onboarding-source"]').forEach((radio) => {
    radio.addEventListener("change", updateSourceFields);
  });
  updateSourceFields();

  if (togglePassword && passwordInput) {
    togglePassword.addEventListener("click", () => {
      const showing = passwordInput.type === "text";
      passwordInput.type = showing ? "password" : "text";
      togglePassword.textContent = showing ? "Show" : "Hide";
      togglePassword.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      togglePassword.setAttribute("aria-pressed", String(!showing));
      passwordInput.focus();
    });
  }

  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (message) message.hidden = true;

    const fullName = (fullNameInput?.value ?? "").trim().replace(/\s+/g, " ");
    const email = (emailInput?.value ?? "").trim().toLowerCase();
    const password = passwordInput?.value ?? "";
    const confirmPassword = confirmPasswordInput?.value ?? "";
    const source = getSource();
    const partnerName = (partnerNameInput?.value ?? "").trim();
    const partnerCode = (partnerCodeInput?.value ?? "").trim();
    const termsAccepted = Boolean(document.querySelector("#accept-terms")?.checked);

    if (fullName.length < 2) {
      showMessage("Enter your full legal name to continue.", "error");
      fullNameInput?.focus();
      return;
    }
    if (!email || !emailInput?.checkValidity()) {
      showMessage("Enter a valid email address.", "error");
      emailInput?.focus();
      return;
    }
    if (password.length < 10) {
      showMessage("Choose a password with at least 10 characters.", "error");
      passwordInput?.focus();
      return;
    }
    if (password !== confirmPassword) {
      showMessage("The passwords do not match. Check them and try again.", "error");
      confirmPasswordInput?.focus();
      return;
    }
    if (source === "partner_referral" && !partnerName) {
      showMessage("Enter the name of the company or organization that referred you.", "error");
      partnerNameInput?.focus();
      return;
    }
    if (source === "partner_referral" && !partnerCode) {
      showMessage("Enter the referral code provided by the company that referred you.", "error");
      partnerCodeInput?.focus();
      return;
    }
    if (!termsAccepted) {
      showMessage("Please acknowledge that the current Terms and Privacy pages are drafts for this development build.", "error");
      document.querySelector("#accept-terms")?.focus();
      return;
    }
    if (!window.refundSupabaseReady || !client) {
      showMessage("Supabase is not connected. Check the Project URL and publishable key in js/config.js, save the file, then reload this page.", "warning");
      return;
    }

    setLoading(true);
    try {
      const emailRedirectTo = new URL("login.html", window.location.href).toString();
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo,
          data: {
            // These are user-provided signup details, not authorization claims.
            // Partner associations must be verified server-side before business routing.
            full_name: fullName,
            onboarding_source: source,
            partner_name: source === "partner_referral" ? partnerName : null,
            partner_referral_code: source === "partner_referral" && partnerCode ? partnerCode : null
          }
        }
      });

      if (error) {
        console.warn("Supabase registration failed:", error.message);
        showMessage("We couldn't complete registration right now. Check your details and connection, then try again. If you already have an account, sign in or reset your password.", "error");
        return;
      }

      form.reset();
      updateSourceFields();

      if (data?.session) {
        showMessage("Your account has been created. Opening your dashboard…", "success");
        window.setTimeout(() => window.location.assign("customer/dashboard.html"), 700);
        return;
      }

      showMessage("Registration has been submitted. Check your inbox for a confirmation link before signing in. If you already have an account, use Sign in or Forgot password instead.", "success");
    } catch (error) {
      console.error("Unexpected registration error:", error);
      showMessage("Something went wrong while creating your account. Check your connection and try again.", "error");
    } finally {
      setLoading(false);
    }
  });
})();
