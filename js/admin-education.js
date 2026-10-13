(() => {
  'use strict';
  const client = window.refundSupabase;
  const $ = (selector) => document.querySelector(selector);
  const form = $('#ae-form');
  const list = $('#ae-list');
  const message = $('#ae-message');
  const titleInput = $('#ae-title-input');
  const slugInput = $('#ae-slug');
  let articles = [];
  let slugTouched = false;

  const categoryLabels = {
    fraud_awareness: 'Fraud awareness', account_security: 'Account security',
    claims_preparation: 'Preparing a claim', service_safety: 'Evaluating a service',
    recovery_process: 'Recovery process', tax_refunds: 'Tax refund information'
  };

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function showMessage(text, kind = 'info') {
    message.hidden = false;
    message.className = `ae-message${kind === 'error' ? ' is-error' : kind === 'warning' ? ' is-warning' : ''}`;
    message.textContent = text;
  }
  function clearMessage() { message.hidden = true; message.textContent = ''; }
  function slugify(value) {
    return value.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 150);
  }
  function resetForm() {
    form.reset();
    $('#ae-id').value = '';
    $('#ae-read-time').value = '3';
    $('#ae-editor-title').textContent = 'Create article';
    setStatusChip('New draft');
    $('#ae-archive').hidden = true;
    $('#ae-publish').textContent = 'Publish article';
    slugTouched = false;
    clearMessage();
  }
  function setStatusChip(status) {
    const chip = $('#ae-status-chip');
    chip.textContent = status;
    chip.className = `ae-status-chip${status === 'published' ? ' is-published' : status === 'archived' ? ' is-archived' : ''}`;
  }
  function selectArticle(article) {
    clearMessage();
    $('#ae-id').value = article.id;
    titleInput.value = article.title;
    slugInput.value = article.slug;
    slugTouched = true;
    $('#ae-excerpt').value = article.excerpt;
    $('#ae-category').value = article.category;
    $('#ae-read-time').value = String(article.read_time_minutes || 3);
    $('#ae-body').value = article.content_markdown;
    $('#ae-featured').checked = Boolean(article.featured);
    $('#ae-editor-title').textContent = 'Edit article';
    setStatusChip(article.status);
    $('#ae-archive').hidden = article.status === 'archived';
    $('#ae-publish').textContent = article.status === 'published' ? 'Save published changes' : 'Publish article';
    document.querySelectorAll('.ae-list-item').forEach((item) => item.classList.toggle('is-selected', item.dataset.id === article.id));
    if (article.status === 'published') {
      showMessage('This article is public. Saving changes will update the live version after validation.', 'warning');
    }
  }
  function renderList() {
    const search = $('#ae-search').value.trim().toLowerCase();
    const visible = articles.filter((article) => `${article.title} ${article.slug} ${article.excerpt}`.toLowerCase().includes(search));
    list.replaceChildren();
    if (!visible.length) {
      list.append(node('div', 'ae-empty', articles.length ? 'No articles match this search.' : 'No articles yet. Create the first article using the editor.'));
      return;
    }
    visible.forEach((article) => {
      const item = node('article', 'ae-list-item'); item.dataset.id = article.id;
      const top = node('div', 'ae-list-top');
      const title = node('h3', '', article.title);
      const chip = node('span', `ae-status-chip${article.status === 'published' ? ' is-published' : article.status === 'archived' ? ' is-archived' : ''}`, article.status);
      top.append(title, chip); item.append(top);
      item.append(node('p', '', `${categoryLabels[article.category] || article.category} · ${article.slug}`));
      item.append(node('p', '', article.excerpt));
      const actions = node('div', 'ae-list-actions');
      const edit = node('button', 'ae-link-button', 'Edit article'); edit.type = 'button'; edit.addEventListener('click', () => selectArticle(article)); actions.append(edit);
      if (article.status === 'published') {
        const view = node('a', 'ae-link-button', 'View public ↗'); view.href = `../education-article.html?slug=${encodeURIComponent(article.slug)}`; view.target = '_blank'; view.rel = 'noopener'; actions.append(view);
      }
      item.append(actions); list.append(item);
    });
  }
  async function loadArticles() {
    clearMessage();
    const { data, error } = await client.from('education_articles').select('*').order('updated_at', { ascending: false });
    if (error) throw error;
    articles = data || [];
    $('#ae-total').textContent = String(articles.length);
    $('#ae-published').textContent = String(articles.filter((a) => a.status === 'published').length);
    $('#ae-drafts').textContent = String(articles.filter((a) => a.status === 'draft').length);
    $('#ae-archived').textContent = String(articles.filter((a) => a.status === 'archived').length);
    renderList();
  }
  function validateForm() {
    if (!form.reportValidity()) return false;
    const body = $('#ae-body').value.trim();
    if (body.length < 80 || body.length > 20000) {
      showMessage('Article body must contain between 80 and 20,000 characters.', 'error');
      $('#ae-body').focus(); return false;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugInput.value.trim())) {
      showMessage('Use a lowercase URL slug with words separated by hyphens.', 'error');
      slugInput.focus(); return false;
    }
    return true;
  }
  async function saveArticle(status) {
    clearMessage();
    if (!validateForm()) return;
    const id = $('#ae-id').value;
    const payload = {
      title: titleInput.value.trim(), slug: slugInput.value.trim(), excerpt: $('#ae-excerpt').value.trim(),
      category: $('#ae-category').value, content_markdown: $('#ae-body').value.trim(),
      read_time_minutes: Number($('#ae-read-time').value), featured: $('#ae-featured').checked, status
    };
    const buttons = [$('#ae-save-draft'), $('#ae-publish'), $('#ae-archive')];
    buttons.forEach((button) => button.disabled = true);
    try {
      let result;
      if (id) result = await client.from('education_articles').update(payload).eq('id', id).select('*').single();
      else result = await client.from('education_articles').insert(payload).select('*').single();
      if (result.error) throw result.error;
      await loadArticles();
      selectArticle(result.data);
      const publicText = status === 'published' ? ' The guide is now publicly available.' : status === 'archived' ? ' The guide has been removed from the public library.' : ' The draft is saved and not public.';
      showMessage(`Article saved successfully.${publicText}`);
    } catch (error) {
      console.error('Could not save education article:', error.message);
      showMessage(error.code === '23505' ? 'That URL slug is already in use. Choose a different slug.' : `Could not save the article: ${error.message}`, 'error');
    } finally {
      buttons.forEach((button) => button.disabled = false);
    }
  }

  async function init() {
    if (!window.refundSupabaseReady || !client) {
      showMessage('Supabase is not connected. Check js/config.js and js/supabase-client.js.', 'error'); return;
    }
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError || !sessionData.session) { window.location.assign('../login.html'); return; }
    const user = sessionData.session.user;
    const { data: roles, error: rolesError } = await client.from('user_roles').select('role').eq('user_id', user.id);
    if (rolesError) throw rolesError;
    if (!(roles || []).some((row) => ['admin', 'super_admin'].includes(row.role))) {
      showMessage('This workspace is restricted to administrators.', 'error');
      $('#ae-user-email').textContent = user.email || 'Signed in';
      return;
    }
    $('#ae-user-email').textContent = user.email || 'Administrator';
    await loadArticles();
  }

  titleInput.addEventListener('input', () => { if (!slugTouched) slugInput.value = slugify(titleInput.value); });
  slugInput.addEventListener('input', () => { slugTouched = true; });
  $('#ae-new').addEventListener('click', resetForm);
  $('#ae-refresh').addEventListener('click', () => loadArticles().catch((error) => showMessage(`Could not refresh articles: ${error.message}`, 'error')));
  $('#ae-search').addEventListener('input', renderList);
  $('#ae-save-draft').addEventListener('click', () => saveArticle('draft'));
  $('#ae-publish').addEventListener('click', () => saveArticle('published'));
  $('#ae-archive').addEventListener('click', async () => {
    if (!$('#ae-id').value) return;
    if (!window.confirm('Archive this article? It will no longer appear in the public resource library.')) return;
    await saveArticle('archived');
  });
  $('#ae-signout').addEventListener('click', async () => { await client.auth.signOut(); window.location.assign('../login.html'); });
  init().catch((error) => {
    console.error('Education admin initialization failed:', error.message);
    showMessage('Unable to initialize the editor. Check the migration, administrator role, and RLS policies.', 'error');
  });
})();
