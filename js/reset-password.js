(() => {
  const requestForm = document.querySelector("#reset-request-form");
  const updateForm = document.querySelector("#reset-update-form");
  const requestEmail = document.querySelector("#reset-email");
  const newPassword = document.querySelector("#new-password");
  const confirmPassword = document.querySelector("#confirm-password");
  const requestButton = document.querySelector("#reset-request-submit");
  const updateButton = document.querySelector("#reset-update-submit");
  const requestMessage = document.querySelector("#reset-request-message");
  const updateMessage = document.querySelector("#reset-update-message");
  const year = document.querySelector("#current-year");
  const client = window.refundSupabase;

  if (year) year.textContent = String(new Date().getFullYear());

  function showMessage(element, text, kind = "info") {
    if (!element) return;
    element.hidden = false;
    element.className = `form-message is-${kind}`;
    element.textContent = text;
  }

  function toggleButton(button, loading, activeText, idleText) {
    if (!button) return;
    button.disabled = loading;
    button.classList.toggle("is-loading", loading);
    button.setAttribute("aria-busy", String(loading));
    const label = button.querySelector(".button-label");
    if (label) label.textContent = loading ? activeText : idleText;
  }

  function showUpdateForm() {
    if (requestForm) requestForm.hidden = true;
    if (updateForm) updateForm.hidden = false;
  }

  if (!window.refundSupabaseReady || !client) {
    showMessage(requestMessage, "Supabase is not connected yet. Add your Project URL and publishable key to js/config.js before using password recovery.", "warning");
  } else {
    // Supabase emits PASSWORD_RECOVERY after the user opens a valid recovery link.
    client.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" && session) showUpdateForm();
    });
  }

  if (requestForm) {
    requestForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (requestMessage) requestMessage.hidden = true;
      const email = requestEmail?.value.trim() ?? "";
      if (!email || !requestEmail.checkValidity()) {
        showMessage(requestMessage, "Enter a valid email address.", "error");
        return;
      }
      if (!window.refundSupabaseReady || !client) {
        showMessage(requestMessage, "Connect Supabase in js/config.js first.", "warning");
        return;
      }

      toggleButton(requestButton, true, "Sending request…", "Send reset link");
      try {
        const redirectTo = `${window.location.origin}/reset-password.html`;
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) {
          console.warn("Password reset request failed:", error.message);
          showMessage(requestMessage, "We couldn't send the reset request right now. Check the setup and try again.", "error");
          return;
        }
        // Intentionally avoid confirming whether the address has an account.
        showMessage(requestMessage, "If an account uses that email address, a password reset link will be sent. Check your inbox and spam folder.", "success");
        requestForm.reset();
      } catch (error) {
        console.error("Unexpected password reset error:", error);
        showMessage(requestMessage, "Something went wrong. Check your connection and try again.", "error");
      } finally {
        toggleButton(requestButton, false, "Sending request…", "Send reset link");
      }
    });
  }

  if (updateForm) {
    updateForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (updateMessage) updateMessage.hidden = true;
      const password = newPassword?.value ?? "";
      const confirm = confirmPassword?.value ?? "";
      if (password.length < 10) {
        showMessage(updateMessage, "Choose a password with at least 10 characters.", "error");
        return;
      }
      if (password !== confirm) {
        showMessage(updateMessage, "The passwords do not match.", "error");
        confirmPassword?.focus();
        return;
      }
      if (!window.refundSupabaseReady || !client) {
        showMessage(updateMessage, "Supabase is not connected. Check js/config.js.", "warning");
        return;
      }

      toggleButton(updateButton, true, "Updating password…", "Update password");
      try {
        const { error } = await client.auth.updateUser({ password });
        if (error) {
          showMessage(updateMessage, "The password could not be updated. Open the newest recovery link from your email and try again.", "error");
          return;
        }
        showMessage(updateMessage, "Your password has been updated. You can now sign in with your new password.", "success");
        updateForm.reset();
        window.setTimeout(() => window.location.assign("login.html"), 1400);
      } catch (error) {
        console.error("Password update failed:", error);
        showMessage(updateMessage, "Something went wrong while updating your password. Please try again.", "error");
      } finally {
        toggleButton(updateButton, false, "Updating password…", "Update password");
      }
    });
  }
})();
