// Shared UI building blocks: DOM helper, notices, menus, modals, prompts and settings controls.

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function setIcon(el, name, size) {
  el.querySelector(':scope > .svg-icon')?.remove();
  el.prepend(icon(name, size));
}

// ---------- favicons (cached locally from pages you visit; never fetched from a third party) ----------
const faviconCache = (() => {
  try { return new Map(JSON.parse(localStorage.getItem('favicons') || '[]')); } catch { return new Map(); }
})();
function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
function rememberFavicon(url, favicon) {
  const host = hostOf(url);
  if (!host || !favicon || faviconCache.get(host) === favicon) return;
  faviconCache.delete(host);
  faviconCache.set(host, favicon);
  while (faviconCache.size > 3000) faviconCache.delete(faviconCache.keys().next().value);
  clearTimeout(rememberFavicon.t);
  rememberFavicon.t = setTimeout(() => { try { localStorage.setItem('favicons', JSON.stringify([...faviconCache])); } catch {} }, 1000);
}
function faviconEl(url, fallback = 'globe', size = 16) {
  const src = faviconCache.get(hostOf(url));
  if (!src) return icon(fallback, size - 2);
  const img = h('img', { src, width: size, height: size, draggable: 'false' });
  img.onerror = () => img.replaceWith(icon(fallback, size - 2));
  return img;
}

// Real brand icons: bundled logos for built-in engines, the site's own favicon for custom ones.
const ASSET_BASE = '../../assets/';
function engineIcon(engine, size = 16) {
  let src = engine.icon ? ASSET_BASE + engine.icon : '';
  if (!src) { try { src = new URL(engine.url.replace('%s', '')).origin + '/favicon.ico'; } catch {} }
  const img = h('img', { src, width: size, height: size, draggable: 'false', class: 'brand-icon' });
  img.onerror = () => img.replaceWith(icon('search', size));
  return img;
}
function appLogo(size = 16) {
  return h('img', { src: ASSET_BASE + 'icon.png', width: size, height: size, draggable: 'false', class: 'app-logo-img' });
}

// ---------- notices ----------
function notice(message, { type = '', timeout = 4000 } = {}) {
  const el = h('div', { class: `notice ${type ? 'is-' + type : ''}` }, message);
  el.onclick = () => el.remove();
  document.getElementById('notices').append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

// ---------- floating layers ----------
const layer = () => document.getElementById('layer');
let activeFloating = null;
function closeFloating() {
  if (activeFloating) { activeFloating.close(); activeFloating = null; }
}
function placeFloating(el, anchor) {
  layer().append(el);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const w = el.offsetWidth, ht = el.offsetHeight;
  const isEl = anchor instanceof Element;
  const besideRibbon = isEl && r.right < 80; // ribbon buttons open to the right, like Obsidian
  let x = !isEl ? r.left : besideRibbon ? r.right + 8 : r.left + (r.right - r.left) / 2 < innerWidth / 2 ? r.left : r.right - w;
  let y = besideRibbon ? r.top : r.bottom + 6;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  if (y + ht > innerHeight - 8) y = Math.max(8, (anchor instanceof Element ? r.top - ht - 6 : innerHeight - ht - 8));
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}
function openFloating(el, anchor, onClose) {
  closeFloating();
  placeFloating(el, anchor);
  const outside = (e) => { if (!el.contains(e.target) && !(anchor instanceof Element && anchor.contains(e.target))) closeFloating(); };
  const esc = (e) => { if (e.key === 'Escape') closeFloating(); };
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', esc, true);
    window.addEventListener('blur', closeFloating);
  });
  activeFloating = {
    el,
    anchor,
    close() {
      el.remove();
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('blur', closeFloating);
      onClose?.();
    },
  };
  return activeFloating;
}

// items: { title, icon, img, hint, onClick, disabled, warning, checked } | '-' | { label }
function showMenu(items, anchor) {
  const menu = h('div', { class: 'menu' });
  for (const item of items.filter(Boolean)) {
    if (item === '-') { menu.append(h('div', { class: 'menu-separator' })); continue; }
    if (item.label) { menu.append(h('div', { class: 'menu-label' }, item.label)); continue; }
    menu.append(h('div', {
      class: `menu-item ${item.disabled ? 'is-disabled' : ''} ${item.warning ? 'is-warning' : ''}`,
      onclick: () => { closeFloating(); item.onClick?.(); },
    },
    item.img ? item.img : icon(item.checked ? 'check' : item.icon || 'none', 16),
    h('span', { class: 'menu-item-title' }, item.title),
    item.hint ? h('span', { class: 'menu-item-hint' }, item.hint) : null,
    item.img && item.checked ? icon('check', 14) : null));
  }
  if (!items.some((i) => i && i.icon) && !items.some((i) => i && i.checked !== undefined)) {
    menu.querySelectorAll('.menu-item > .svg-icon').forEach((s) => s.remove());
  }
  return openFloating(menu, anchor);
}

function showPopover(content, anchor, onClose) {
  return openFloating(h('div', { class: 'popover' }, content), anchor, onClose);
}

// ---------- modals ----------
function openModal({ className = '', content, onClose, closeButton = true, dismissable = true }) {
  closeFloating();
  const container = h('div', { class: 'modal-container' });
  const close = () => {
    container.remove();
    document.removeEventListener('keydown', esc, true);
    onClose?.();
  };
  const esc = (e) => { if (e.key === 'Escape' && dismissable && container === layer().lastElementChild) { e.stopPropagation(); close(); } };
  const modal = h('div', { class: `modal ${className}` },
    closeButton ? h('button', { class: 'clickable-icon modal-close', onclick: close, 'aria-label': 'Close' }, icon('x')) : null,
    content);
  container.append(h('div', { class: 'modal-bg', onclick: () => dismissable && close() }), modal);
  layer().append(container);
  document.addEventListener('keydown', esc, true);
  return { container, modal, close };
}

function promptText(title, value = '', { placeholder = '', cta = 'Save' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'text', value, placeholder, spellcheck: false });
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = openModal({
      content: [
        h('div', { class: 'modal-title' }, title),
        input,
        h('div', { class: 'modal-button-container' },
          h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
          h('button', { class: 'mod-cta', onclick: () => finish(input.value.trim()) }, cta)),
      ],
      onClose: () => finish(null),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim()); });
    setTimeout(() => { input.focus(); input.select(); });
  });
}

function confirmDialog(title, message, cta = 'Confirm', warning = true) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = openModal({
      content: [
        h('div', { class: 'modal-title' }, title),
        h('div', { class: 'setting-item-description', style: { fontSize: '14px' } }, message),
        h('div', { class: 'modal-button-container' },
          h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
          h('button', { class: warning ? 'mod-warning' : 'mod-cta', onclick: () => finish(true) }, cta)),
      ],
      onClose: () => finish(false),
    });
  });
}

// ---------- fuzzy search (used by command palette & quick switcher) ----------
function fuzzyMatch(query, text) {
  if (!query) return { score: 0, ranges: [] };
  const q = query.toLowerCase(), t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return { score: 100 - direct - t.length * 0.01, ranges: [[direct, direct + q.length]] };
  let ti = 0, score = 0, ranges = [], last = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (found === last + 1) { ranges[ranges.length - 1][1] = found + 1; score += 3; }
    else { ranges.push([found, found + 1]); score += 1; }
    last = found;
    ti = found + 1;
  }
  return { score: score - t.length * 0.01, ranges };
}
function highlight(text, ranges) {
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a > pos) frag.append(text.slice(pos, a));
    frag.append(h('span', { class: 'suggestion-highlight' }, text.slice(a, b)));
    pos = b;
  }
  frag.append(text.slice(pos));
  return frag;
}

// getItems(query) -> [{ title, note, icon|img, hint, run, score?, ranges? }]
function openPrompt({ placeholder, getItems, instructions = [['↑↓', 'to navigate'], ['↵', 'to use'], ['esc', 'to dismiss']] }) {
  const input = h('input', { class: 'prompt-input', placeholder, spellcheck: false });
  const results = h('div', { class: 'prompt-results' });
  let items = [], selected = 0;
  const m = openModal({
    closeButton: false,
    content: [input, results, h('div', { class: 'prompt-instructions' }, instructions.map(([k, t]) => h('span', {}, h('b', {}, k), t)))],
  });
  m.container.classList.add('mod-prompt');
  m.modal.className = 'prompt';

  const choose = (i) => { const it = items[i]; if (!it) return; m.close(); it.run(); };
  const render = async () => {
    const q = input.value;
    items = await getItems(q);
    if (q !== input.value) return;
    selected = Math.min(selected, Math.max(0, items.length - 1));
    results.replaceChildren(...(items.length ? items.map((it, i) => h('div', {
      class: `suggestion-item mod-complex ${i === selected ? 'is-selected' : ''}`,
      onmousemove: () => { if (selected !== i) { selected = i; paint(); } },
      onclick: () => choose(i),
    },
    it.img || icon(it.icon || 'file', 16),
    h('div', { class: 'suggestion-content' },
      h('div', { class: 'suggestion-title' }, it.ranges ? highlight(it.title, it.ranges) : it.title),
      it.note ? h('div', { class: 'suggestion-note' }, it.note) : null),
    it.hint ? h('kbd', {}, it.hint) : null)) : [h('div', { class: 'empty-state' }, 'No matches found.')]));
  };
  const paint = () => [...results.children].forEach((c, i) => c.classList.toggle('is-selected', i === selected));
  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { selected = (selected + 1) % Math.max(1, items.length); paint(); results.children[selected]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { selected = (selected - 1 + items.length) % Math.max(1, items.length); paint(); results.children[selected]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(selected); e.preventDefault(); }
  });
  render();
  setTimeout(() => input.focus());
  return m;
}

// ---------- settings controls ----------
function settingItem(name, description, ...controls) {
  return h('div', { class: 'setting-item' },
    h('div', { class: 'setting-item-info' },
      h('div', { class: 'setting-item-name' }, name),
      description ? h('div', { class: 'setting-item-description' }, description) : null),
    h('div', { class: 'setting-item-control' }, controls));
}
function settingHeading(name) {
  return h('div', { class: 'setting-item setting-item-heading' }, h('div', { class: 'setting-item-info' }, h('div', { class: 'setting-item-name' }, name)));
}
function toggle(checked, onChange) {
  const el = h('div', { class: `checkbox-container ${checked ? 'is-enabled' : ''}`, role: 'switch', tabindex: 0 });
  const flip = () => {
    const on = !el.classList.contains('is-enabled');
    el.classList.toggle('is-enabled', on);
    onChange(on);
  };
  el.addEventListener('click', flip);
  el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
  return el;
}
function dropdown(options, value, onChange) {
  const sel = h('select', { class: 'dropdown', onchange: () => onChange(sel.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  return sel;
}
function textInput(value, onChange, props = {}) {
  const el = h('input', { class: 'text', value: value ?? '', spellcheck: false, ...props });
  el.addEventListener('change', () => onChange?.(el.value));
  return el;
}
function btn(label, onClick, kind = 'btn') {
  return h('button', { class: kind, onclick: onClick }, label);
}
function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}
function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
