(() => {
  'use strict';
  const client = window.refundSupabase;
  const grid = document.querySelector('#edu-grid');
  const featured = document.querySelector('#edu-featured');
  const search = document.querySelector('#edu-search');
  const category = document.querySelector('#edu-category');
  const total = document.querySelector('#edu-total');
  const message = document.querySelector('#edu-message');
  const empty = document.querySelector('#edu-empty');
  const clear = document.querySelector('#edu-clear');
  let articles = [];

  const categoryLabels = {
    fraud_awareness: 'Fraud awareness',
    account_security: 'Account security',
    claims_preparation: 'Preparing a claim',
    service_safety: 'Evaluating a service',
    recovery_process: 'Recovery process',
    tax_refunds: 'Tax refund information'
  };

  function showMessage(text, kind = 'info') {
    message.hidden = false;
    message.className = `edu-message${kind === 'error' ? ' is-error' : ''}`;
    message.textContent = text;
  }

  function clearMessage() {
    message.hidden = true;
    message.textContent = '';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function cardFor(article, isFeatured = false) {
    const card = el('article', 'edu-card');
    if (isFeatured) card.classList.add('edu-card-featured');
    if (isFeatured) card.append(el('span', 'edu-card-feature-label', 'Featured guide'));
    card.append(el('p', 'edu-card-category', categoryLabels[article.category] || 'Resource'));
    card.append(el('h3', '', article.title));
    card.append(el('p', 'edu-card-excerpt', article.excerpt));
    const footer = el('div', 'edu-card-footer');
    const minutes = Math.max(1, Number(article.read_time_minutes) || 3);
    footer.append(el('span', 'edu-card-meta', `${minutes} min read`));
    const link = el('a', 'edu-read-link', 'Read guide →');
    link.href = `education-article.html?slug=${encodeURIComponent(article.slug)}`;
    footer.append(link);
    card.append(footer);
    return card;
  }

  function render() {
    clearMessage();
    const term = search.value.trim().toLowerCase();
    const selected = category.value;
    const filtered = articles.filter((article) => {
      const haystack = `${article.title} ${article.excerpt} ${article.category} ${article.slug}`.toLowerCase();
      return (!term || haystack.includes(term)) && (selected === 'all' || article.category === selected);
    });
    total.textContent = `${filtered.length} ${filtered.length === 1 ? 'guide' : 'guides'}`;
    grid.replaceChildren();
    featured.replaceChildren();
    const featuredArticle = (!term && selected === 'all') ? filtered.find((article) => article.featured) : null;
    if (featuredArticle) {
      featured.hidden = false;
      featured.append(cardFor(featuredArticle, true));
    } else {
      featured.hidden = true;
    }
    const ordinary = featuredArticle ? filtered.filter((article) => article.id !== featuredArticle.id) : filtered;
    ordinary.forEach((article) => grid.append(cardFor(article)));
    empty.hidden = ordinary.length > 0 || Boolean(featuredArticle);
    grid.hidden = ordinary.length === 0;
  }

  async function loadArticles() {
    if (!window.refundSupabaseReady || !client) {
      grid.replaceChildren(); grid.hidden = true; featured.hidden = true;
      showMessage('The resource library could not connect. Check js/config.js, js/supabase-client.js, and that migration 008 has been run.', 'error');
      total.textContent = 'Unavailable';
      return;
    }
    grid.hidden = false;
    grid.replaceChildren(el('article', 'edu-skeleton'), el('article', 'edu-skeleton'), el('article', 'edu-skeleton'));
    const { data, error } = await client.from('education_articles')
      .select('id,title,slug,excerpt,category,featured,read_time_minutes,published_at')
      .eq('status', 'published')
      .order('featured', { ascending: false })
      .order('published_at', { ascending: false });
    if (error) {
      grid.replaceChildren(); grid.hidden = true;
      showMessage('We could not load the resource library. Please refresh the page; if this continues, check the database migration and public-read policy.', 'error');
      total.textContent = 'Unavailable';
      console.error('Education library query failed:', error.message);
      return;
    }
    articles = data || [];
    if (!articles.length) {
      grid.replaceChildren(); grid.hidden = true; featured.hidden = true;
      showMessage('No guides are published yet. Please check back soon.');
      total.textContent = '0 guides';
      empty.hidden = true;
      return;
    }
    render();
  }

  search.addEventListener('input', render);
  category.addEventListener('change', render);
  clear.addEventListener('click', () => { search.value = ''; category.value = 'all'; render(); });
  loadArticles().catch((error) => {
    console.error('Education library unexpected error:', error);
    showMessage('A temporary error prevented the guides from loading. Please refresh and try again.', 'error');
  });
})();
