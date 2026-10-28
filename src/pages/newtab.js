// Link start page: search box with engine picker, most-visited sites and protection stats.
const $ = (id) => document.getElementById(id);
const api = (path) => fetch(path, { headers: { 'x-link-token': document.querySelector('meta[name="link-token"]').content } });
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const SHIELD = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>';
const GLOBE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';

function engineImg(engine) {
  const img = el('img', { alt: '', width: 16, height: 16 });
  img.src = engine.icon ? `/${engine.icon}` : `${new URL(engine.url.replace('%s', '')).origin}/favicon.ico`;
  return img;
}

async function load() {
  const state = await api('/api/state').then((r) => r.json());
  const light = state.theme === 'light' || (state.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  document.body.className = light ? 'theme-light' : 'theme-dark';

  let engine = state.engines.find((e) => e.id === state.engine) || state.engines[0];
  const list = $('engine-list');
  const paintEngine = () => {
    $('engine-btn').replaceChildren(engineImg(engine));
    $('engine-btn').title = engine.name;
    $('q').placeholder = `Search with ${engine.name} or enter address`;
    list.replaceChildren(...state.engines.map((e) => {
      const li = el('li', { role: 'option' }, engineImg(e), e.name);
      if (e.id === engine.id) li.append(el('span', { className: 'check', textContent: '✓' }));
      li.onclick = () => {
        engine = e;
        api(`/api/engine?id=${encodeURIComponent(e.id)}`);
        list.hidden = true;
        paintEngine();
        $('q').focus();
      };
      return li;
    }));
  };
  paintEngine();
  $('engine-btn').onclick = () => { list.hidden = !list.hidden; };
  document.addEventListener('mousedown', (e) => { if (!$('search').contains(e.target)) list.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.hidden = true; });

  $('search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('q').value.trim();
    if (!q) return;
    const looksUrl = !/\s/.test(q) && /^([a-z]+:\/\/)?[^\s/]+\.[a-z]{2,}(\/.*)?$/i.test(q);
    location.href = looksUrl ? (/^[a-z]+:\/\//i.test(q) ? q : `https://${q}`) : engine.url.replace('%s', encodeURIComponent(q));
  });

  const seen = new Set();
  const sites = [...state.topSites, ...state.bookmarks].filter((s) => {
    try {
      const host = new URL(s.url).hostname;
      if (seen.has(host) || !/^https?:/.test(s.url)) return false;
      seen.add(host);
      return true;
    } catch { return false; }
  }).slice(0, 8);
  for (const s of sites) {
    const { origin, hostname } = new URL(s.url);
    const host = hostname.replace(/^www\./, '');
    const iconBox = el('div', { className: 'icon', textContent: host[0].toUpperCase() });
    const img = new Image();
    img.onload = () => iconBox.replaceChildren(img);
    img.src = `${origin}/favicon.ico`;
    $('sites').append(el('a', { className: 'site', href: s.url, title: s.title || host }, iconBox, el('span', { textContent: host })));
  }

  $('stats').innerHTML = `<span>${SHIELD}${state.blocked.toLocaleString()} ads &amp; trackers blocked</span><span>${GLOBE}VPN ${state.vpn ? 'on' : 'off'}</span>`;
}

load();
