(() => {
  'use strict';
  const client = window.refundSupabase;
  const params = new URLSearchParams(window.location.search);
  const slug = (params.get('slug') || '').trim();
  const message = document.querySelector('#article-message');
  const shell = document.querySelector('#article-content');
  const title = document.querySelector('#article-title');
  const category = document.querySelector('#article-category');
  const excerpt = document.querySelector('#article-excerpt');
  const readTime = document.querySelector('#article-read-time');
  const date = document.querySelector('#article-date');
  const body = document.querySelector('#article-body');
  const categoryLabels = {
    fraud_awareness: 'Fraud awareness', account_security: 'Account security',
    claims_preparation: 'Preparing a claim', service_safety: 'Evaluating a service',
    recovery_process: 'Recovery process', tax_refunds: 'Tax refund information'
  };

  function showMessage(text, kind = 'info') {
    message.hidden = false;
    message.className = `edu-message${kind === 'error' ? ' is-error' : ''}`;
    message.textContent = text;
  }

  function addTextBlock(parent, tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    parent.append(node);
    return node;
  }

  // Very small safe renderer: only recognizes headings and simple bullet lists.
  // All source content is inserted with textContent; raw HTML is never executed.
  function renderBody(markdown) {
    body.replaceChildren();
    let paragraph = [];
    let list = null;
    const flushParagraph = () => {
      if (paragraph.length) {
        addTextBlock(body, 'p', paragraph.join(' '));
        paragraph = [];
      }
    };
    const flushList = () => { list = null; };
    for (const rawLine of String(markdown || '').replace(/\r/g, '').split('\n')) {
      const line = rawLine.trim();
      if (!line) { flushParagraph(); flushList(); continue; }
      const heading = /^(#{2,3})\s+(.+)$/.exec(line);
      if (heading) {
        flushParagraph(); flushList();
        addTextBlock(body, heading[1].length === 2 ? 'h2' : 'h3', heading[2]);
        continue;
      }
      if (line.startsWith('- ')) {
        flushParagraph();
        if (!list) { list = document.createElement('ul'); body.append(list); }
        addTextBlock(list, 'li', line.slice(2));
        continue;
      }
      flushList();
      paragraph.push(line.replace(/^\*\*(.+)\*\*$/, '$1'));
    }
    flushParagraph();
  }

  async function load() {
    if (!slug || !window.refundSupabaseReady || !client) {
      showMessage(slug ? 'This guide is temporarily unavailable. Please try again later.' : 'No guide was selected. Return to the resource center and choose an article.', 'error');
      return;
    }
    const { data, error } = await client.from('education_articles')
      .select('title,slug,excerpt,category,content_markdown,read_time_minutes,published_at')
      .eq('slug', slug).eq('status', 'published').maybeSingle();
    if (error) {
      console.error('Education article query failed:', error.message);
      showMessage('We could not load this guide. Please try again later.', 'error');
      return;
    }
    if (!data) {
      showMessage('This guide is not available. It may have been unpublished or the link may be incorrect.', 'error');
      return;
    }
    document.title = `${data.title} | Refund Guides`;
    title.textContent = data.title;
    category.textContent = categoryLabels[data.category] || 'Resource guide';
    excerpt.textContent = data.excerpt;
    readTime.textContent = `${Math.max(1, Number(data.read_time_minutes) || 3)} min read`;
    const published = data.published_at ? new Date(data.published_at) : null;
    date.textContent = published && !Number.isNaN(published.getTime())
      ? `Updated ${published.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`
      : 'Public guide';
    renderBody(data.content_markdown);
    shell.hidden = false;
  }

  load().catch((error) => {
    console.error('Education article unexpected error:', error);
    showMessage('A temporary error prevented this guide from loading.', 'error');
  });
})();
