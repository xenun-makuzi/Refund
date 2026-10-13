/*
 * Initializes the Supabase browser client from js/config.js.
 * The project URL and publishable key are intentionally read from config.js.
 * Never place a service-role or secret key in browser code.
 */
(() => {
  "use strict";

  const config = window.REFUND_SUPABASE_CONFIG;
  const url = typeof config?.url === "string" ? config.url.trim() : "";
  const publishableKey = typeof config?.publishableKey === "string"
    ? config.publishableKey.trim()
    : "";

  const isPlaceholder = (value) =>
    !value ||
    /^(PASTE_YOUR_|YOUR_|REPLACE_ME|<.*?>|\.{3})/i.test(value) ||
    /YOUR_(SUPABASE|PROJECT|PUBLISHABLE)/i.test(value);

  let validProjectUrl = false;
  try {
    const parsedUrl = new URL(url);
    validProjectUrl =
      parsedUrl.protocol === "https:" &&
      parsedUrl.hostname.endsWith(".supabase.co") &&
      !isPlaceholder(url);
  } catch (_error) {
    validProjectUrl = false;
  }

  // Accept modern Supabase publishable keys and legacy anon JWT keys.
  const validKeyShape =
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey) ||
    /^eyJ[A-Za-z0-9._-]+$/.test(publishableKey);

  const configured =
    validProjectUrl &&
    validKeyShape &&
    !isPlaceholder(publishableKey);

  if (!configured) {
    window.refundSupabaseReady = false;
    window.refundSupabase = null;
    window.refundSupabaseConfigError =
      "Missing or invalid Supabase URL/publishable key in js/config.js.";
    console.error(window.refundSupabaseConfigError);
    return;
  }

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    window.refundSupabaseReady = false;
    window.refundSupabase = null;
    window.refundSupabaseConfigError =
      "Supabase JavaScript SDK did not load. Check the CDN/network connection.";
    console.error(window.refundSupabaseConfigError);
    return;
  }

  try {
    window.refundSupabase = window.supabase.createClient(
      url.replace(/\/+$/, ""),
      publishableKey,
      {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true
        }
      }
    );
    window.refundSupabaseReady = true;
    window.refundSupabaseConfigError = null;
  } catch (error) {
    window.refundSupabaseReady = false;
    window.refundSupabase = null;
    window.refundSupabaseConfigError = "Unable to initialize Supabase client.";
    console.error(window.refundSupabaseConfigError, error);
  }
})();
