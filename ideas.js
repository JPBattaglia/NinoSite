// The Ideas board on ninobattaglia.com/ideas.html (Nov 9, 2026). The same board as the Nino app's Ideas tab: fans
// post a design idea (it shows only after Nino OKs it from his emailed link) and vote on the ones on the board. The
// shop API keeps it (commerce-api/src/fans.mjs: GET/POST /api/ideas, POST /api/ideas/vote).
//
// Who's who: no accounts. A visitor who came from the app uses the app's key (site.js keeps it). Anyone else gets a
// random key kept in this browser under its own name, so it never counts toward the app's shirt rewards.
(() => {
  'use strict';
  const root = document.querySelector('[data-ideas]');
  if (!root) return;
  const api = String(window.NINO_COMMERCE_CONFIG?.apiBase || '').replace(/\/$/, '');
  const form = root.querySelector('[data-idea-form]');
  const textBox = form.querySelector('#idea-text');
  const nameBox = form.querySelector('#idea-name');
  const trap = form.querySelector('#idea-website');
  const send = form.querySelector('[data-idea-send]');
  const status = form.querySelector('[data-idea-status]');
  const counter = form.querySelector('[data-idea-count]');
  const list = root.querySelector('[data-idea-list]');
  const mine = root.querySelector('[data-idea-mine]');
  const mineList = root.querySelector('[data-idea-mine-list]');
  const sortGroup = root.querySelector('[data-idea-sort]');
  const boardStatus = root.querySelector('[data-board-status]');
  const MAX = 280, MIN = 8;
  const SITE_KEY = 'nino-ideas-member';
  const KEY_OK = /^[A-Za-z0-9_-]{32,64}$/;
  let ideas = [];
  let sort = 'top';
  let memo = '';

  function memberKey() {
    if (memo) return memo;
    const fromApp = window.NinoApp?.member?.();
    if (fromApp) return (memo = fromApp);
    try { const saved = localStorage.getItem(SITE_KEY); if (KEY_OK.test(saved || '')) return (memo = saved); } catch { /* storage off */ }
    const bytes = crypto.getRandomValues(new Uint8Array(30));
    memo = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    try { localStorage.setItem(SITE_KEY, memo); } catch { /* votes last for this visit only */ }
    return memo;
  }

  async function request(path, body) {
    let response;
    try {
      response = await fetch(`${api}${path}`, body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, member: memberKey(), source: 'site' }) }
        : { headers: { Accept: 'application/json' } });
    } catch {
      throw new Error('The board can’t be reached right now. Check your connection and try again.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Something went wrong. Please try again in a minute.');
    return data;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function when(seconds) {
    const days = Math.floor((Date.now() / 1000 - Number(seconds)) / 86400);
    if (!Number.isFinite(days) || days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  const voteLabel = idea => `${idea.voted ? 'Take back your vote for' : 'Vote for'} this idea. ${idea.votes} ${idea.votes === 1 ? 'vote' : 'votes'}.`;
  const HEART = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M12 20.7l-1.4-1.3C5.4 14.7 2 11.6 2 7.8 2 4.7 4.4 2.3 7.5 2.3c1.7 0 3.4.8 4.5 2.1 1.1-1.3 2.8-2.1 4.5-2.1 3.1 0 5.5 2.4 5.5 5.5 0 3.8-3.4 6.9-8.6 11.6z"/></svg>';

  function card(idea, rank) {
    const item = el('li', 'idea-card');
    item.dataset.id = idea.id;
    if (rank) item.append(el('span', 'idea-rank', String(rank).padStart(2, '0')));
    const body = el('div', 'idea-body');
    body.append(el('p', 'idea-text', `“${idea.text}”`));
    body.append(el('p', 'idea-by', `${idea.name || 'A fan'} · ${when(idea.created_at)}`));
    item.append(body);
    const vote = el('button', 'idea-vote');
    vote.type = 'button';
    vote.dataset.vote = idea.id;
    vote.setAttribute('aria-pressed', String(Boolean(idea.voted)));
    vote.setAttribute('aria-label', voteLabel(idea));
    vote.innerHTML = HEART;
    vote.append(el('span', 'idea-votes', String(idea.votes)));
    item.append(vote);
    return item;
  }

  function draw() {
    list.setAttribute('aria-busy', 'false');
    list.replaceChildren();
    if (!ideas.length) {
      list.append(el('li', 'empty-state ideas-empty', 'No ideas on the board yet. Yours could be the first one Nino draws!'));
      return;
    }
    const shown = sort === 'new' ? [...ideas].sort((a, b) => b.created_at - a.created_at) : ideas;
    shown.forEach((idea, i) => list.append(card(idea, sort === 'top' ? i + 1 : 0)));
  }

  function drawMine(pending) {
    mineList.replaceChildren();
    for (const idea of pending || []) {
      const item = el('li');
      item.append(el('span', null, `“${idea.text}”`), el('small', null, `Sent ${when(idea.created_at)}`));
      mineList.append(item);
    }
    mine.hidden = !mineList.children.length;
  }

  async function load() {
    try {
      const data = await request(`/api/ideas?member=${encodeURIComponent(memberKey())}`);
      ideas = Array.isArray(data.ideas) ? data.ideas : [];
      draw();
      drawMine(data.pending);
    } catch (error) {
      list.setAttribute('aria-busy', 'false');
      list.replaceChildren(el('li', 'empty-state', error.message));
    }
  }

  // Votes show at once and are put right if the board says otherwise.
  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-vote]');
    if (!button || button.disabled) return;
    const idea = ideas.find(i => i.id === button.dataset.vote);
    if (!idea) return;
    const before = { voted: idea.voted, votes: idea.votes };
    idea.voted = !idea.voted;
    idea.votes = Math.max(0, idea.votes + (idea.voted ? 1 : -1));
    const show = () => {
      button.setAttribute('aria-pressed', String(Boolean(idea.voted)));
      button.setAttribute('aria-label', voteLabel(idea));
      button.querySelector('.idea-votes').textContent = String(idea.votes);
    };
    show();
    button.disabled = true;
    boardStatus.textContent = '';
    try {
      const result = await request('/api/ideas/vote', { id: idea.id });
      idea.voted = Boolean(result.voted);
      idea.votes = Number(result.votes) || 0;
    } catch (error) {
      Object.assign(idea, before);
      if (/isn.t on the board/.test(error.message)) { ideas = ideas.filter(i => i !== idea); draw(); }
      boardStatus.textContent = error.message;
    } finally {
      button.disabled = false;
      if (button.isConnected) show();
    }
  });

  sortGroup.addEventListener('click', event => {
    const button = event.target.closest('[data-sort]');
    if (!button || button.dataset.sort === sort) return;
    sort = button.dataset.sort;
    for (const b of sortGroup.querySelectorAll('[data-sort]')) { b.setAttribute('aria-pressed', String(b === button)); b.classList.toggle('is-active', b === button); }
    draw();
  });

  function setStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle('is-error', Boolean(isError));
    status.classList.toggle('is-done', !isError && Boolean(message));
  }

  function count() {
    const n = textBox.value.length;
    counter.textContent = `${n} / ${MAX}`;
    counter.classList.toggle('is-near', n > MAX - 30);
  }
  textBox.addEventListener('input', () => { count(); if (status.classList.contains('is-error')) setStatus(''); });
  count();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = textBox.value.replace(/\s+/g, ' ').trim();
    if (text.length < MIN) { setStatus('Tell Nino a little more about your idea.', true); textBox.focus(); return; }
    if (/https?:\/\/|www\./i.test(text)) { setStatus('Please leave links out of your idea.', true); textBox.focus(); return; }
    send.disabled = true;
    send.textContent = 'Sending…';
    setStatus('');
    try {
      await request('/api/ideas', { text, name: nameBox.value.trim(), website: trap.value });
      textBox.value = '';
      count();
      setStatus('Sent! Nino will read it soon. It shows on the board once he OKs it.');
      load();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      send.disabled = false;
      send.textContent = 'Send to Nino';
    }
  });

  load();
})();
