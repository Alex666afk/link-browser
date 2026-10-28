// Link Search results page.
const $ = (id) => document.getElementById(id);
const api = (path) => fetch(path, { headers: { 'x-link-token': document.querySelector('meta[name="link-token"]').content } });
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};
const params = new URLSearchParams(location.search);
const query = (params.get('q') || '').trim();
let page = 1;

function favicon(url, size = 14) {
  const { origin, hostname } = new URL(url);
  const box = el('span', { className: 'fav', textContent: hostname.replace(/^www\./, '')[0].toUpperCase() });
  const img = new Image(size, size);
  img.onload = () => box.replaceChildren(img);
  img.src = `${origin}/favicon.ico`;
  return box;
}

function breadcrumb(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean).slice(0, 3).map(decodeURIComponent);
  return [u.hostname.replace(/^www\./, ''), ...parts].join(' › ');
}

function resultEl(r) {
  return el('div', { className: 'result' },
    el('div', { className: 'result-body' },
      el('div', { className: 'result-site' }, favicon(r.url), el('span', { className: 'path', textContent: breadcrumb(r.url) })),
      el('a', { className: 'result-title', href: r.url, textContent: r.title }),
      el('div', { className: 'result-snippet' },
        r.date ? el('span', { className: 'date', textContent: new Date(r.date).toLocaleDateString() + ' — ' }) : null,
        r.content)),
    r.thumbnail ? el('img', { className: 'result-thumb', src: r.thumbnail, alt: '', loading: 'lazy' }) : null);
}

function searchLink(text) {
  return el('a', { className: 'chip', href: `?q=${encodeURIComponent(text)}`, textContent: text });
}

function renderElsewhere(others) {
  const nav = $('elsewhere');
  nav.replaceChildren(el('span', { className: 'label', textContent: 'Also search on' }), ...others.map((e) => {
    const img = el('img', { src: `/${e.icon}`, alt: '' });
    return el('a', { href: e.url.replace('%s', encodeURIComponent(query)) }, img, e.name);
  }));
}

function renderSide(data) {
  const side = $('side');
  side.replaceChildren();
  const ib = data.infobox;
  if (ib) {
    side.append(el('div', { className: 'panel' },
      ib.image ? el('img', { className: 'hero', src: ib.image, alt: '' }) : null,
      el('h2', { textContent: ib.title }),
      ib.content ? el('p', { textContent: ib.content.length > 500 ? ib.content.slice(0, 500) + '…' : ib.content }) : null,
      ib.attributes.length ? el('dl', {}, ...ib.attributes.flatMap((a) => [el('dt', { textContent: a.label }), el('dd', { textContent: a.value })])) : null,
      ib.links.length ? el('div', { className: 'links' }, ...ib.links.map((l) => el('a', { href: l.url, textContent: l.title }))) : null));
  }
  if (data.library?.length) {
    side.append(el('div', { className: 'panel' },
      el('h3', { textContent: 'From your library' }),
      ...data.library.map((item) => el('a', { className: 'lib-item', href: item.url, title: item.url },
        favicon(item.url), el('span', { textContent: item.title || item.url }), el('small', { textContent: item.kind })))));
  }
}

function renderState(title, text, button) {
  $('main').replaceChildren(el('div', { className: 'state' }, el('h2', { textContent: title }), el('div', { textContent: text }), button || null));
}

async function load() {
  const main = $('main');
  if (page === 1) main.replaceChildren(...Array.from({ length: 5 }, () => el('div', { className: 'skeleton' })));
  const card = page === 1 ? liveCard(query) : null; // e.g. map, timer, calculator, weather
  if (card) main.prepend(card);
  const data = await api(`/api/results?q=${encodeURIComponent(query)}&page=${page}`).then((r) => r.json());
  document.body.className = data.theme === 'light' || (data.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches) ? 'theme-light' : 'theme-dark';
  if (page === 1) { renderElsewhere(data.others); renderSide(card ? { ...data, infobox: null } : data); }

  if (data.error && card) { main.replaceChildren(card); return; }
  if (data.error) {
    const retry = el('button', { className: 'more', textContent: 'Try again' });
    retry.onclick = () => location.reload();
    return renderState('Couldn’t get results', 'Link Search couldn’t reach the web just now. Check your connection (or VPN), try again, or use one of the engines above.', retry);
  }

  if (page === 1) {
    main.replaceChildren();
    if (card) main.append(card);
    if (data.correction) main.append(el('div', { className: 'correction' }, 'Did you mean ', searchLink(data.correction), '?'));
    for (const a of data.answers) main.append(el('div', { className: 'answer', textContent: a }));
    if (!data.results.length && card) return;
    if (!data.results.length) return renderState('No results', `Nothing found for “${query}”. Try different words or another engine above.`);
  }
  main.querySelector('.more')?.remove();
  main.querySelector('.related')?.remove();
  for (const r of data.results) main.append(resultEl(r));
  if (data.suggestions.length && page === 1) {
    main.append(el('div', { className: 'related' }, el('h3', { textContent: 'Related searches' }), el('div', {}, ...data.suggestions.map(searchLink))));
  }
  if (data.hasMore && data.results.length) {
    const more = el('button', { className: 'more', textContent: 'More results' });
    more.onclick = () => { more.textContent = 'Loading…'; page++; load(); };
    main.append(more);
  }
}

$('q').value = query;
document.title = query ? `${query} — Link Search` : 'Link Search';
$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (q) location.href = `?q=${encodeURIComponent(q)}`;
});
if (query) load();
else { $('q').focus(); renderState('Link Search', 'Results from across the web, with no ads and no tracking.'); }
