(() => {
  const client = window.refundSupabase;
  const ready = window.refundSupabaseReady;
  const message = document.querySelector('#admin-dashboard-message');
  const refreshButton = document.querySelector('#refresh-dashboard');
  const signOutButton = document.querySelector('#admin-sign-out');
  const roleLabel = document.querySelector('#admin-user-role');
  const emailLabel = document.querySelector('#admin-user-email');
  const recentClaims = document.querySelector('#recent-claims');
  const moduleChecks = document.querySelector('#module-checks');

  const metrics = {
    claimsPending: { table: 'claims', filter: q => q.in('status', ['submitted', 'under_review', 'awaiting_information']) },
    identityPending: { table: 'identity_verification_submissions', filter: q => q.eq('status', 'pending'), optional: true },
    payoutPending: { table: 'payout_requests', filter: q => q.eq('status', 'requested') },
    loanPending: { table: 'loan_applications', filter: q => q.in('status', ['submitted', 'under_review']) },
    loanWithdrawalPending: { table: 'loan_withdrawal_requests', filter: q => q.eq('status', 'requested') },
    supportOpen: { table: 'support_tickets', filter: q => q.in('status', ['open', 'in_progress', 'escalated']) },
    riskOpen: { table: 'risk_review_flags', filter: q => q.in('status', ['open', 'under_review']) }
  };

  const moduleStatus = new Map();

  function showMessage(text, kind = 'warning') {
    if (!message) return;
    message.hidden = false;
    message.className = `ad-message${kind === 'error' ? ' is-error' : ''}`;
    message.textContent = text;
  }

  function hideMessage() {
    if (!message) return;
    message.hidden = true;
    message.textContent = '';
  }

  function formatDate(value) {
    if (!value) return 'Date unavailable';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Date unavailable';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function humanize(value) {
    return String(value || 'unknown').replaceAll('_', ' ');
  }

  function setMetric(key, value, title = '') {
    const target = document.querySelector(`[data-metric="${key}"]`);
    if (!target) return;
    target.textContent = value;
    if (title) target.title = title;
  }

  function setBadgeCount(id, value) {
    const target = document.getElementById(id);
    if (target) target.textContent = value;
  }

  async function countRows(table, configure = null) {
    let query = client.from(table).select('id', { count: 'exact', head: true });
    if (configure) query = configure(query);
    const { count, error } = await query;
    if (error) throw error;
    return Number(count || 0);
  }

  async function checkRole(userId) {
    const { data, error } = await client
      .from('user_roles')
      .select('role')
      .eq('user_id', userId);
    if (error) throw error;
    const roles = (data || []).map(row => row.role);
    return { roles, isAdmin: roles.some(role => ['admin', 'super_admin'].includes(role)) };
  }

  function renderRecentClaims(rows) {
    if (!recentClaims) return;
    recentClaims.replaceChildren();
    if (!rows?.length) {
      const empty = document.createElement('div');
      empty.className = 'ad-empty-state';
      empty.textContent = 'No claims were returned. New submissions will appear here.';
      recentClaims.append(empty);
      return;
    }

    rows.forEach(row => {
      const item = document.createElement('a');
      item.className = 'ad-recent-item';
      item.href = 'claims.html';

      const info = document.createElement('div');
      info.className = 'ad-recent-info';
      const title = document.createElement('strong');
      title.textContent = `${row.case_reference || 'Claim'} · ${row.title || 'Untitled case'}`;
      const meta = document.createElement('span');
      meta.textContent = `${formatDate(row.created_at)}${row.merchant_name ? ` · ${row.merchant_name}` : ''}`;
      info.append(title, meta);

      const status = document.createElement('span');
      status.className = 'ad-status-pill';
      status.textContent = humanize(row.status);
      item.append(info, status);
      recentClaims.append(item);
    });
  }

  function renderModuleChecks(items) {
    if (!moduleChecks) return;
    moduleChecks.replaceChildren();
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'ad-check-item';
      const dot = document.createElement('span');
      dot.className = `ad-check-dot${item.state === 'warning' ? ' warning' : item.state === 'error' ? ' error' : ''}`;
      const copy = document.createElement('div');
      copy.className = 'ad-check-copy';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const detail = document.createElement('span');
      detail.textContent = item.detail;
      copy.append(title, detail);
      row.append(dot, copy);
      moduleChecks.append(row);
    });
  }

  async function loadDashboard(user) {
    if (refreshButton) refreshButton.disabled = true;
    hideMessage();
    const checks = [];

    const metricResults = await Promise.all(Object.entries(metrics).map(async ([key, config]) => {
      try {
        const count = await countRows(config.table, config.filter);
        setMetric(key, count.toLocaleString());
        moduleStatus.set(key, 'ready');
        return { key, ok: true, count };
      } catch (error) {
        setMetric(key, '—', error?.message || 'Could not load count');
        moduleStatus.set(key, 'unavailable');
        checks.push({
          title: config.table,
          detail: config.optional ? 'Optional module table not available yet, or access needs review.' : 'Could not read count. Verify migration and admin access policies.',
          state: 'warning'
        });
        return { key, ok: false, error };
      }
    }));

    const claimsPending = metricResults.find(result => result.key === 'claimsPending');
    const payoutPending = metricResults.find(result => result.key === 'payoutPending');
    const loanPending = metricResults.find(result => result.key === 'loanPending');
    const identityPending = metricResults.find(result => result.key === 'identityPending');
    const supportOpen = metricResults.find(result => result.key === 'supportOpen');
    const loanWithdrawalPending = metricResults.find(result => result.key === 'loanWithdrawalPending');
    const riskOpen = metricResults.find(result => result.key === 'riskOpen');

    setBadgeCount('nav-claims-count', claimsPending?.ok ? claimsPending.count : '—');
    setBadgeCount('nav-payout-count', payoutPending?.ok ? payoutPending.count : '—');
    setBadgeCount('nav-loans-count', (loanPending?.ok && loanWithdrawalPending?.ok) ? (loanPending.count + loanWithdrawalPending.count).toLocaleString() : '—');
    setBadgeCount('nav-identity-count', identityPending?.ok ? identityPending.count : '—');
    setBadgeCount('nav-support-count', supportOpen?.ok ? supportOpen.count : '—');
    setBadgeCount('nav-risk-count', riskOpen?.ok ? riskOpen.count : '—');

    try {
      const { count, error } = await client.from('user_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', user.id)
        .eq('is_read', false);
      if (error) throw error;
      setBadgeCount('nav-notifications-count', Number(count || 0).toLocaleString());
    } catch (error) {
      setBadgeCount('nav-notifications-count', '—');
      checks.push({ title: 'Notifications', detail: 'Could not read notification count; review migration 005 and its RLS policies.', state: 'warning' });
    }

    try {
      const { data, error } = await client
        .from('claims')
        .select('id,case_reference,title,status,merchant_name,created_at')
        .order('created_at', { ascending: false })
        .limit(5);
      if (error) throw error;
      renderRecentClaims(data || []);
    } catch (error) {
      if (recentClaims) {
        recentClaims.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'ad-empty-state';
        empty.textContent = 'Recent claims could not be loaded. Check migration 002 and admin read policies.';
        recentClaims.append(empty);
      }
      checks.push({ title: 'Claims feed', detail: 'Latest claim records could not be read.', state: 'error' });
    }

    // Non-critical module checks: gracefully handle optional/not-yet-installed migrations.
    try {
      const { count, error } = await client.from('claim_workflow_templates')
        .select('id', { count: 'exact', head: true }).eq('is_active', true);
      if (error) throw error;
      checks.push({ title: 'Configurable workflows', detail: `${Number(count || 0)} active workflow template(s) available.`, state: 'ready' });
    } catch (error) {
      checks.push({ title: 'Configurable workflows', detail: 'Workflow module unavailable; verify migration 007 and RLS.', state: 'warning' });
    }

    try {
      const { count, error } = await client.from('education_articles')
        .select('id', { count: 'exact', head: true }).eq('status', 'published');
      if (error) throw error;
      checks.push({ title: 'Education center', detail: `${Number(count || 0)} published article(s).`, state: 'ready' });
      document.querySelectorAll('[data-module-status="education"]').forEach(el => { el.textContent = `${Number(count || 0)} published article(s)`; });
    } catch (error) {
      checks.push({ title: 'Education center', detail: 'Migration 008 may not be installed, or admin access needs review.', state: 'warning' });
      document.querySelectorAll('[data-module-status="education"]').forEach(el => { el.textContent = 'Check migration 008'; });
    }

    try {
      const { count, error } = await client.from('identity_verification_submissions')
        .select('id', { count: 'exact', head: true });
      if (error) throw error;
      document.querySelectorAll('[data-module-status="identity"]').forEach(el => { el.textContent = `${Number(count || 0)} submission(s) on record`; });
      checks.push({ title: 'Identity verification', detail: `${Number(count || 0)} submission(s) on record.`, state: 'ready' });
    } catch (error) {
      document.querySelectorAll('[data-module-status="identity"]').forEach(el => { el.textContent = 'Check migration 009'; });
      // The main priority card already explains if its count was unavailable.
    }

    if (checks.length === 0) {
      checks.push({ title: 'Core modules', detail: 'Dashboard data checks completed.', state: 'ready' });
    }
    renderModuleChecks(checks);

    const unavailableCount = metricResults.filter(result => !result.ok).length;
    if (unavailableCount > 0) {
      showMessage(`${unavailableCount} queue count(s) could not be loaded. The related module may not be installed yet or its access policies may need review. Open the module check list below for details.`);
    }
    if (refreshButton) refreshButton.disabled = false;
  }

  async function boot() {
    const date = document.getElementById('dashboard-date');
    if (date) date.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());

    if (!ready || !client) {
      showMessage('Supabase is not connected. Check js/config.js and js/supabase-client.js.', 'error');
      if (emailLabel) emailLabel.textContent = 'Connection not ready';
      if (roleLabel) roleLabel.textContent = 'Configuration required';
      return;
    }

    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError || !sessionData?.session) {
      window.location.replace('../login.html');
      return;
    }

    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError || !userData?.user) {
      window.location.replace('../login.html');
      return;
    }

    let roleData;
    try {
      roleData = await checkRole(userData.user.id);
    } catch (error) {
      showMessage('Could not verify your administrator role. Check the user_roles SELECT policy and try signing in again.', 'error');
      if (emailLabel) emailLabel.textContent = userData.user.email || 'Signed-in user';
      if (roleLabel) roleLabel.textContent = 'Role check failed';
      return;
    }

    if (!roleData.isAdmin) {
      showMessage('Administrator access is required to open this dashboard. You have not been shown any admin data.', 'error');
      if (emailLabel) emailLabel.textContent = userData.user.email || 'Signed-in user';
      if (roleLabel) roleLabel.textContent = roleData.roles.length ? roleData.roles.join(', ') : 'No application role found';
      return;
    }

    if (emailLabel) emailLabel.textContent = userData.user.email || 'Administrator';
    if (roleLabel) roleLabel.textContent = roleData.roles.includes('super_admin') ? 'Super administrator' : 'Administrator';
    await loadDashboard(userData.user);
  }

  if (refreshButton) refreshButton.addEventListener('click', async () => {
    const { data } = await client?.auth.getUser?.() || {};
    if (data?.user) await loadDashboard(data.user);
    else await boot();
  });

  if (signOutButton) signOutButton.addEventListener('click', async () => {
    signOutButton.disabled = true;
    try {
      if (client) await client.auth.signOut();
    } finally {
      window.location.assign('../login.html');
    }
  });

  boot().catch(error => {
    console.error('Admin dashboard failed to initialize:', error);
    showMessage('The admin dashboard could not finish loading. Refresh the page or inspect the browser console.', 'error');
    if (refreshButton) refreshButton.disabled = false;
  });
})();
