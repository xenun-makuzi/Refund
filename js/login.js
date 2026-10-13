(() => {
  const form = document.querySelector("#login-form");
  const emailInput = document.querySelector("#email");
  const passwordInput = document.querySelector("#password");
  const submitButton = document.querySelector("#login-submit");
  const message = document.querySelector("#auth-message");
  const togglePassword = document.querySelector("#toggle-password");
  const year = document.querySelector("#current-year");

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
    if (label) label.textContent = isLoading ? "Signing you in…" : "Sign in securely";
  }

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

    const email = emailInput?.value.trim() ?? "";
    const password = passwordInput?.value ?? "";

    if (!email || !password) {
      showMessage("Enter your email address and password to continue.", "error");
      return;
    }
    if (!emailInput.checkValidity()) {
      showMessage("Enter a valid email address.", "error");
      emailInput.focus();
      return;
    }
    if (!window.refundSupabaseReady || !window.refundSupabase) {
      showMessage("Supabase is not connected yet. Add your Project URL and publishable key to js/config.js, save the file, and try again.", "warning");
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await window.refundSupabase.auth.signInWithPassword({ email, password });
      if (error) {
        // Use a general message to avoid revealing whether an account exists.
        showMessage("We couldn't sign you in with those details. Check your email and password, then try again.", "error");
        console.warn("Supabase sign-in failed:", error.message);
        return;
      }
      if (!data?.session) {
        showMessage("Your sign-in needs another step. Check your email for any verification message, then try again.", "warning");
        return;
      }
      showMessage("Sign-in successful. Opening your dashboard…", "success");

      // Route staff to the appropriate workspace based on server-stored roles.
      // If role lookup fails, safely fall back to the customer dashboard; each admin page
      // independently enforces authorization before reading privileged data.
      let destination = "customer/dashboard.html";
      try {
        const signedInUserId = data.user?.id;
        if (signedInUserId) {
          const { data: roleRows, error: roleError } = await window.refundSupabase
            .from("user_roles")
            .select("role")
            .eq("user_id", signedInUserId);
          if (!roleError) {
            const roles = (roleRows || []).map((row) => row.role);
            if (roles.some((role) => ["admin", "super_admin"].includes(role))) {
              destination = "admin/dashboard.html";
            } else if (roles.includes("investigator")) {
              destination = "admin/claims.html";
            } else if (roles.includes("support_agent")) {
              destination = "admin/support.html";
            }
          }
        }
      } catch (roleLookupError) {
        console.warn("Could not load application role for routing:", roleLookupError);
      }
      window.location.assign(destination);
    } catch (error) {
      console.error("Unexpected sign-in error:", error);
      showMessage("We couldn't complete sign-in right now. Check your connection and try again.", "error");
    } finally {
      setLoading(false);
    }
  });
})();
