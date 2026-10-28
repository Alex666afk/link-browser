// Live cards shown above Link Search results: maps, timers, calculator, conversions, weather, clocks…
// liveCard(query) returns a card element, or null when the query isn't one of these.

const tokenHeader = () => ({ 'x-link-token': document.querySelector('meta[name="link-token"]').content });
const answerApi = (kind, params) => fetch(`/api/answer/${kind}?${new URLSearchParams(params)}`, { headers: tokenHeader() }).then((r) => r.json());

function h2(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style') node.style.cssText = v;
    else node[k] = v;
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}
const card = (cls, ...children) => h2('section', { class: `live-card ${cls}` }, ...children);
const fmt = (n, max = 6) => (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-6 && n !== 0) ? n.toExponential(4) : n.toLocaleString(undefined, { maximumFractionDigits: max }));

// ------------------------------------------------------------ sound
function chime(times = 3) {
  const ctx = new AudioContext();
  for (let i = 0; i < times; i++) {
    for (const [f, d] of [[880, 0], [1320, 0.18]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      const t = ctx.currentTime + i * 0.9 + d;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.55);
    }
  }
}

// ------------------------------------------------------------ map / location
function mapFrame(query, zoom = 13) {
  return h2('iframe', {
    class: 'map', loading: 'lazy', referrerPolicy: 'no-referrer-when-downgrade',
    src: `https://maps.google.com/maps?q=${encodeURIComponent(query)}&z=${zoom}&output=embed`,
  });
}

function locationCard(real = false) {
  const title = h2('div', { class: 'card-title' }, 'Your location');
  const caption = h2('div', { class: 'card-sub' }, 'Finding your location…');
  const body = h2('div', { class: 'map-wrap' });
  const c = card('mod-map', title, caption, body);
  answerApi('location', real ? { real: 1 } : {}).then((l) => {
    if (l.error) { caption.textContent = 'Couldn’t find your location right now.'; return; }
    const place = [l.city, l.region, l.country].filter(Boolean).join(', ');
    if (l.viaVpn) {
      title.textContent = 'Where websites see you';
      caption.replaceChildren(place, h2('span', { class: 'muted' }, ' · Link VPN is on, so your real location is hidden'));
    } else {
      caption.replaceChildren(place, h2('span', { class: 'muted' }, ' · approximate, based on your internet connection'));
    }
    body.append(mapFrame(`${l.lat},${l.lon}`, l.viaVpn ? 10 : 12),
      h2('a', { class: 'chip', href: `https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lon}` }, 'Open in Google Maps'));
    if (l.viaVpn) body.append(h2('button', { class: 'chip', onclick: () => c.replaceWith(locationCard(true)) }, 'Show my real location'));
  });
  return c;
}

function placeMapCard(placeName) {
  return card('mod-map',
    h2('div', { class: 'card-title' }, placeName),
    h2('div', { class: 'map-wrap' }, mapFrame(placeName),
      h2('a', { class: 'chip', href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(placeName)}` }, 'Open in Google Maps'),
      h2('a', { class: 'chip', href: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(placeName)}` }, 'Directions')));
}

// ------------------------------------------------------------ timer & stopwatch
function parseDuration(text) {
  const t = text.toLowerCase().replace(/\band\b/g, ' ');
  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t.trim());
  if (clock) return clock[3] !== undefined ? (+clock[1] * 3600 + +clock[2] * 60 + +clock[3]) : (+clock[1] * 60 + +clock[2]);
  let total = 0, found = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b/g)) {
    found = true;
    const n = parseFloat(m[1]);
    total += m[2].startsWith('h') ? n * 3600 : m[2].startsWith('m') ? n * 60 : n;
  }
  if (!found && /^\d+(\.\d+)?$/.test(t.trim())) return parseFloat(t) * 60; // "timer 5" = 5 minutes
  return found ? Math.round(total) : null;
}
const clockText = (s) => {
  s = Math.max(0, Math.round(s));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : String(mm)) + ':' + String(ss).padStart(2, '0');
};

function timerCard(seconds) {
  let total = seconds || 300, left = total, running = false, endAt = 0, tick = null;
  const display = h2('div', { class: 'big-clock' }, clockText(left));
  const bar = h2('div', { class: 'timer-bar' }, h2('div'));
  const startBtn = h2('button', { class: 'btn mod-primary', onclick: () => (running ? pause() : start()) }, 'Start');
  const paint = () => {
    display.textContent = clockText(left);
    bar.firstChild.style.width = `${(1 - left / total) * 100}%`;
    startBtn.textContent = running ? 'Pause' : left === 0 ? 'Restart' : left < total ? 'Resume' : 'Start';
    document.title = running ? `${clockText(left)} — Timer` : `${query} — Link Search`;
  };
  const start = () => {
    if (left === 0) left = total;
    running = true;
    endAt = Date.now() + left * 1000;
    tick = setInterval(() => {
      left = Math.max(0, (endAt - Date.now()) / 1000);
      if (left <= 0) { clearInterval(tick); running = false; left = 0; chime(); c.classList.add('is-done'); document.title = 'Time’s up — Link'; }
      paint();
    }, 200);
    c.classList.remove('is-done');
    paint();
  };
  const pause = () => { running = false; clearInterval(tick); paint(); };
  const set = (s) => { pause(); total = left = s; c.classList.remove('is-done'); paint(); };
  const c = card('mod-timer',
    h2('div', { class: 'card-title' }, 'Timer'),
    display, bar,
    h2('div', { class: 'row' },
      startBtn,
      h2('button', { class: 'btn', onclick: () => set(total) }, 'Reset'),
      h2('button', { class: 'btn', onclick: () => { total += 60; left += 60; if (running) endAt += 60000; paint(); } }, '+1 min'),
      h2('span', { class: 'spacer' }),
      ...[60, 300, 600, 1500, 3600].map((s) => h2('button', { class: 'chip', onclick: () => set(s) }, s >= 3600 ? '1 h' : `${s / 60} min`))));
  paint();
  if (seconds) start();
  return c;
}

function stopwatchCard() {
  let elapsed = 0, startedAt = 0, running = false, tick = null;
  const laps = h2('ol', { class: 'laps' });
  const now = () => elapsed + (running ? Date.now() - startedAt : 0);
  const text = (ms) => `${clockText(ms / 1000)}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`;
  const display = h2('div', { class: 'big-clock' }, text(0));
  const startBtn = h2('button', { class: 'btn mod-primary', onclick: () => {
    if (running) { elapsed = now(); running = false; clearInterval(tick); }
    else { startedAt = Date.now(); running = true; tick = setInterval(() => { display.textContent = text(now()); }, 31); }
    startBtn.textContent = running ? 'Stop' : 'Start';
  } }, 'Start');
  return card('mod-timer',
    h2('div', { class: 'card-title' }, 'Stopwatch'), display,
    h2('div', { class: 'row' }, startBtn,
      h2('button', { class: 'btn', onclick: () => running && laps.prepend(h2('li', {}, text(now()))) }, 'Lap'),
      h2('button', { class: 'btn', onclick: () => { elapsed = 0; startedAt = Date.now(); display.textContent = text(now()); laps.replaceChildren(); } }, 'Reset')),
    laps);
}

// ------------------------------------------------------------ calculator
function calculate(src) {
  const s = src.toLowerCase().replace(/×|x(?=\s*[\d(])/g, '*').replace(/÷/g, '/').replace(/,/g, '').replace(/\bof\b/g, '*').replace(/=\s*$/, '');
  const tokens = s.match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-z]+|[-+*/^%()!]/g);
  if (!tokens || tokens.join('') !== s.replace(/\s+/g, '')) return null;
  let i = 0;
  const peek = () => tokens[i], next = () => tokens[i++];
  const FN = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, abs: Math.abs, round: Math.round };
  const CONST = { pi: Math.PI, e: Math.E };
  const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term(); return v; };
  const term = () => { let v = power(); while (peek() === '*' || peek() === '/') v = next() === '*' ? v * power() : v / power(); return v; };
  const power = () => { const b = unary(); return peek() === '^' ? (next(), b ** power()) : b; };
  const unary = () => (peek() === '-' ? (next(), -unary()) : peek() === '+' ? (next(), unary()) : postfix());
  const postfix = () => {
    let v = primary();
    while (peek() === '%' || peek() === '!') {
      if (next() === '%') v /= 100;
      else { let f = 1; for (let k = 2; k <= v; k++) f *= k; v = f; }
    }
    return v;
  };
  const primary = () => {
    const t = next();
    if (t === undefined) throw 0;
    if (t === '(') { const v = expr(); if (next() !== ')') throw 0; return v; }
    if (/^[\d.]/.test(t)) return parseFloat(t);
    if (t in CONST) return CONST[t];
    if (t in FN) { if (next() !== '(') throw 0; const v = expr(); if (next() !== ')') throw 0; return FN[t](v); }
    throw 0;
  };
  try {
    const v = expr();
    return i === tokens.length && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

function calculatorCard(initial) {
  const input = h2('input', { class: 'calc-input', value: initial || '', spellcheck: false, placeholder: '0' });
  const result = h2('div', { class: 'calc-result' });
  const update = () => {
    const v = calculate(input.value);
    result.textContent = input.value.trim() ? (v === null ? '…' : `= ${fmt(v, 10)}`) : '';
  };
  const press = (k) => {
    if (k === 'C') input.value = '';
    else if (k === '⌫') input.value = input.value.slice(0, -1);
    else if (k === '=') { const v = calculate(input.value); if (v !== null) input.value = String(+v.toPrecision(12)); }
    else input.value += k;
    update();
    input.focus();
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); press('='); } });
  const keys = ['C', '(', ')', '/', '7', '8', '9', '*', '4', '5', '6', '-', '1', '2', '3', '+', '0', '.', '⌫', '='];
  update();
  return card('mod-calc', h2('div', { class: 'card-title' }, 'Calculator'), input, result,
    h2('div', { class: 'keypad' }, keys.map((k) => h2('button', { class: `key ${k === '=' ? 'mod-primary' : /[\d.]/.test(k) ? '' : 'mod-op'}`, onclick: () => press(k) }, k === '*' ? '×' : k === '/' ? '÷' : k))));
}

// ------------------------------------------------------------ unit conversion
const UNITS = {
  length: { m: 1, mm: 0.001, cm: 0.01, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852 },
  mass: { kg: 1, g: 0.001, mg: 1e-6, t: 1000, oz: 0.028349523125, lb: 0.45359237, st: 6.35029318 },
  volume: { l: 1, ml: 0.001, gal: 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625, tbsp: 0.01478676478125, tsp: 0.00492892159375, m3: 1000 },
  speed: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, kn: 0.514444 },
  data: { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 },
  time: { s: 1, min: 60, h: 3600, day: 86400, week: 604800, month: 2629746, year: 31556952 },
  area: { 'm2': 1, 'km2': 1e6, 'ft2': 0.09290304, acre: 4046.8564224, ha: 10000, 'mi2': 2589988.110336 },
  temperature: { c: 1, f: 1, k: 1 },
};
const ALIASES = {
  meter: 'm', meters: 'm', metre: 'm', metres: 'm', millimeter: 'mm', millimeters: 'mm', centimeter: 'cm', centimeters: 'cm', kilometer: 'km', kilometers: 'km', kms: 'km',
  inch: 'in', inches: 'in', '"': 'in', foot: 'ft', feet: 'ft', "'": 'ft', yard: 'yd', yards: 'yd', mile: 'mi', miles: 'mi',
  kilogram: 'kg', kilograms: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', gram: 'g', grams: 'g', milligram: 'mg', ton: 't', tons: 't', tonne: 't', tonnes: 't',
  ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb', stone: 'st',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l', milliliter: 'ml', milliliters: 'ml', gallon: 'gal', gallons: 'gal', quart: 'qt', quarts: 'qt', pint: 'pt', pints: 'pt', cups: 'cup', 'fl oz': 'floz', tablespoon: 'tbsp', tablespoons: 'tbsp', teaspoon: 'tsp', teaspoons: 'tsp',
  kph: 'km/h', kmh: 'km/h', 'km per hour': 'km/h', 'miles per hour': 'mph', knots: 'kn', knot: 'kn', mps: 'm/s',
  byte: 'b', bytes: 'b', kilobyte: 'kb', kilobytes: 'kb', megabyte: 'mb', megabytes: 'mb', gigabyte: 'gb', gigabytes: 'gb', terabyte: 'tb', terabytes: 'tb',
  second: 's', seconds: 's', sec: 's', secs: 's', minute: 'min', minutes: 'min', mins: 'min', hour: 'h', hours: 'h', hr: 'h', hrs: 'h', days: 'day', weeks: 'week', months: 'month', years: 'year',
  celsius: 'c', '°c': 'c', fahrenheit: 'f', '°f': 'f', kelvin: 'k', 'sq m': 'm2', 'square meters': 'm2', 'sq ft': 'ft2', 'square feet': 'ft2', acres: 'acre', hectare: 'ha', hectares: 'ha',
};
const unitOf = (u) => {
  const k = u.trim().toLowerCase().replace(/\.$/, '');
  const key = ALIASES[k] || k;
  for (const [dim, table] of Object.entries(UNITS)) if (key in table) return { dim, key };
  return null;
};
function convertUnits(n, from, to) {
  if (from.dim !== to.dim) return null;
  if (from.dim === 'temperature') {
    const c = from.key === 'c' ? n : from.key === 'f' ? (n - 32) * 5 / 9 : n - 273.15;
    return to.key === 'c' ? c : to.key === 'f' ? c * 9 / 5 + 32 : c + 273.15;
  }
  return (n * UNITS[from.dim][from.key]) / UNITS[to.dim][to.key];
}

function unitCard(n, from, to) {
  const units = Object.keys(UNITS[from.dim]);
  const amount = h2('input', { class: 'conv-input', type: 'number', value: n });
  const fromSel = h2('select', { class: 'conv-select' }, units.map((u) => h2('option', { value: u, selected: u === from.key }, u)));
  const toSel = h2('select', { class: 'conv-select' }, units.map((u) => h2('option', { value: u, selected: u === to.key }, u)));
  const out = h2('div', { class: 'conv-result' });
  const update = () => {
    const v = convertUnits(parseFloat(amount.value) || 0, { dim: from.dim, key: fromSel.value }, { dim: from.dim, key: toSel.value });
    out.textContent = `${fmt(parseFloat(amount.value) || 0)} ${fromSel.value} = ${fmt(v)} ${toSel.value}`;
  };
  [amount, fromSel, toSel].forEach((x) => x.addEventListener('input', update));
  update();
  return card('mod-conv', h2('div', { class: 'card-title' }, `${from.dim[0].toUpperCase()}${from.dim.slice(1)} converter`), out,
    h2('div', { class: 'row' }, amount, fromSel, h2('button', { class: 'btn', title: 'Swap', onclick: () => { [fromSel.value, toSel.value] = [toSel.value, fromSel.value]; update(); } }, '⇄'), toSel));
}

// ------------------------------------------------------------ currency
const CURRENCY_WORDS = { '$': 'USD', dollar: 'USD', dollars: 'USD', usd: 'USD', '€': 'EUR', euro: 'EUR', euros: 'EUR', '£': 'GBP', pound: 'GBP', pounds: 'GBP', '¥': 'JPY', yen: 'JPY', yuan: 'CNY', rupee: 'INR', rupees: 'INR', peso: 'MXN', pesos: 'MXN', franc: 'CHF', francs: 'CHF', won: 'KRW', real: 'BRL', reais: 'BRL' };
const CODES = ['AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR'];
const currencyOf = (w) => { const k = w.trim().toLowerCase(); const c = CURRENCY_WORDS[k] || k.toUpperCase(); return CODES.includes(c) ? c : null; };

function currencyCard(n, from, to) {
  const amount = h2('input', { class: 'conv-input', type: 'number', value: n });
  const mk = (sel) => h2('select', { class: 'conv-select' }, CODES.map((c) => h2('option', { value: c, selected: c === sel }, c)));
  const fromSel = mk(from), toSel = mk(to);
  const out = h2('div', { class: 'conv-result' }, '…');
  const note = h2('div', { class: 'card-sub' });
  let seq = 0;
  const update = async () => {
    const my = ++seq;
    if (fromSel.value === toSel.value) { out.textContent = `${fmt(+amount.value || 0, 2)} ${fromSel.value}`; return; }
    const r = await answerApi('currency', { amount: +amount.value || 0, from: fromSel.value, to: toSel.value });
    if (my !== seq) return;
    if (r.error) { out.textContent = 'Exchange rates are unavailable right now.'; return; }
    out.textContent = `${fmt(r.amount, 2)} ${r.from} = ${fmt(r.result, 2)} ${r.to}`;
    note.textContent = `Reference rate from the European Central Bank · ${r.date}`;
  };
  [amount, fromSel, toSel].forEach((x) => x.addEventListener('input', update));
  update();
  return card('mod-conv', h2('div', { class: 'card-title' }, 'Currency converter'), out,
    h2('div', { class: 'row' }, amount, fromSel, h2('button', { class: 'btn', title: 'Swap', onclick: () => { [fromSel.value, toSel.value] = [toSel.value, fromSel.value]; update(); } }, '⇄'), toSel), note);
}

// ------------------------------------------------------------ weather
const WMO = [[0, 'Clear', 'sun'], [1, 'Mostly clear', 'sun'], [2, 'Partly cloudy', 'cloud-sun'], [3, 'Overcast', 'cloud'], [45, 'Fog', 'fog'], [48, 'Fog', 'fog'],
  [51, 'Light drizzle', 'rain'], [53, 'Drizzle', 'rain'], [55, 'Heavy drizzle', 'rain'], [56, 'Freezing drizzle', 'rain'], [57, 'Freezing drizzle', 'rain'],
  [61, 'Light rain', 'rain'], [63, 'Rain', 'rain'], [65, 'Heavy rain', 'rain'], [66, 'Freezing rain', 'rain'], [67, 'Freezing rain', 'rain'],
  [71, 'Light snow', 'snow'], [73, 'Snow', 'snow'], [75, 'Heavy snow', 'snow'], [77, 'Snow grains', 'snow'], [80, 'Showers', 'rain'], [81, 'Showers', 'rain'], [82, 'Heavy showers', 'rain'],
  [85, 'Snow showers', 'snow'], [86, 'Snow showers', 'snow'], [95, 'Thunderstorm', 'storm'], [96, 'Thunderstorm', 'storm'], [99, 'Thunderstorm', 'storm']];
const wmo = (code) => WMO.find(([c]) => c === code) || [code, 'Unknown', 'cloud'];
const WICON = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  'cloud-sun': '<path d="M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  rain: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6M8 14v6M12 16v6"/>',
  snow: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01"/>',
  storm: '<path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/>',
  fog: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 17H7M17 21H9"/>',
};
const wIcon = (name, size) => h2('span', { class: 'w-icon', innerHTML: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${WICON[name]}</svg>` });

function weatherCard(placeName) {
  const c = card('mod-weather', h2('div', { class: 'card-sub' }, 'Getting the weather…'));
  let fahrenheit = /^en-US/.test(navigator.language);
  answerApi('weather', { place: placeName }).then((w) => {
    if (w.error) { c.replaceChildren(h2('div', { class: 'card-sub' }, w.error === 'notfound' ? `Couldn’t find “${placeName}”.` : 'Weather is unavailable right now.')); return; }
    const render = () => {
      const t = (cel) => `${Math.round(fahrenheit ? cel * 9 / 5 + 32 : cel)}°`;
      const [, label, ic] = wmo(w.current.weather_code);
      c.replaceChildren(
        h2('div', { class: 'card-title' }, [w.place.name, w.place.region, w.place.country].filter(Boolean).join(', ')),
        h2('div', { class: 'weather-now' },
          wIcon(ic, 56),
          h2('div', { class: 'big-temp' }, t(w.current.temperature_2m)),
          h2('div', { class: 'unit-toggle' },
            h2('button', { class: fahrenheit ? '' : 'is-active', onclick: () => { fahrenheit = false; render(); } }, '°C'),
            h2('button', { class: fahrenheit ? 'is-active' : '', onclick: () => { fahrenheit = true; render(); } }, '°F')),
          h2('div', { class: 'weather-meta' },
            h2('div', { class: 'weather-label' }, label),
            h2('div', {}, `Feels like ${t(w.current.apparent_temperature)} · Humidity ${w.current.relative_humidity_2m}% · Wind ${Math.round(fahrenheit ? w.current.wind_speed_10m / 1.609 : w.current.wind_speed_10m)} ${fahrenheit ? 'mph' : 'km/h'}`))),
        h2('div', { class: 'forecast' }, w.daily.time.map((d, i) => h2('div', { class: 'day' },
          h2('div', { class: 'muted' }, i === 0 ? 'Today' : new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' })),
          wIcon(wmo(w.daily.weather_code[i])[2], 22),
          h2('div', {}, `${t(w.daily.temperature_2m_max[i])} `, h2('span', { class: 'muted' }, t(w.daily.temperature_2m_min[i]))),
          w.daily.precipitation_probability_max?.[i] ? h2('div', { class: 'rain-chance' }, `${w.daily.precipitation_probability_max[i]}%`) : null))));
    };
    render();
  });
  return c;
}

// ------------------------------------------------------------ clocks & dates
function clockCard(placeName) {
  const timeEl = h2('div', { class: 'big-clock' });
  const dateEl = h2('div', { class: 'card-sub' });
  const title = h2('div', { class: 'card-title' }, placeName ? `Time in ${placeName}` : 'Local time');
  const c = card('mod-clock', title, timeEl, dateEl);
  const start = (tz) => {
    const paint = () => {
      const now = new Date();
      timeEl.textContent = now.toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit' });
      dateEl.textContent = `${now.toLocaleDateString(undefined, { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}${tz ? ' · ' + tz.replace(/_/g, ' ') : ''}`;
    };
    paint();
    setInterval(paint, 1000);
  };
  if (!placeName) start(undefined);
  else answerApi('time', { place: placeName }).then((r) => {
    if (r.error) { timeEl.textContent = ''; dateEl.textContent = `Couldn’t find “${placeName}”.`; return; }
    title.textContent = `Time in ${[r.place.name, r.place.country].filter(Boolean).join(', ')}`;
    start(r.place.timezone);
  });
  return c;
}

// ------------------------------------------------------------ dictionary
function defineCard(word) {
  const c = card('mod-define', h2('div', { class: 'card-sub' }, `Looking up “${word}”…`));
  answerApi('define', { word }).then((d) => {
    if (d.error) { c.remove(); return; }
    const audio = d.audio ? new Audio(d.audio) : null;
    c.replaceChildren(
      h2('div', { class: 'define-head' },
        h2('div', { class: 'define-word' }, d.word),
        d.phonetic ? h2('span', { class: 'muted' }, d.phonetic) : null,
        audio ? h2('button', { class: 'btn', title: 'Listen', onclick: () => audio.play() }, '▶ Listen') : null),
      ...d.meanings.map((m) => h2('div', { class: 'meaning' },
        h2('div', { class: 'pos' }, m.partOfSpeech),
        h2('ol', {}, m.definitions.map((x) => h2('li', {}, x.definition, x.example ? h2('div', { class: 'example' }, `“${x.example}”`) : null))),
        m.synonyms.length ? h2('div', { class: 'synonyms' }, 'Similar: ', m.synonyms.map((s) => h2('a', { class: 'chip', href: `?q=${encodeURIComponent('define ' + s)}` }, s))) : null)));
  });
  return c;
}

// ------------------------------------------------------------ small random things
function coinCard() {
  const out = h2('div', { class: 'big-clock coin' });
  const flip = () => { out.classList.remove('spin'); void out.offsetWidth; out.classList.add('spin'); out.textContent = Math.random() < 0.5 ? 'Heads' : 'Tails'; };
  flip();
  return card('mod-random', h2('div', { class: 'card-title' }, 'Coin flip'), out, h2('div', { class: 'row' }, h2('button', { class: 'btn mod-primary', onclick: flip }, 'Flip again')));
}

function diceCard() {
  let count = 1;
  const out = h2('div', { class: 'dice' });
  const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  const total = h2('div', { class: 'card-sub' });
  const roll = () => {
    const vals = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6));
    out.replaceChildren(...vals.map((v) => h2('span', { class: 'die spin' }, FACES[v - 1])));
    total.textContent = count > 1 ? `Total: ${vals.reduce((a, b) => a + b, 0)}` : `You rolled ${vals[0]}`;
  };
  roll();
  return card('mod-random', h2('div', { class: 'card-title' }, 'Dice'), out, total,
    h2('div', { class: 'row' }, h2('button', { class: 'btn mod-primary', onclick: roll }, 'Roll'),
      ...[1, 2, 3, 4].map((n) => h2('button', { class: 'chip', onclick: () => { count = n; roll(); } }, `${n} ${n === 1 ? 'die' : 'dice'}`))));
}

function randomCard(min = 1, max = 100) {
  const lo = h2('input', { class: 'conv-input', type: 'number', value: min });
  const hi = h2('input', { class: 'conv-input', type: 'number', value: max });
  const out = h2('div', { class: 'big-clock' });
  const gen = () => {
    const a = Math.ceil(Math.min(+lo.value, +hi.value)), b = Math.floor(Math.max(+lo.value, +hi.value));
    out.textContent = String(a + Math.floor(Math.random() * (b - a + 1)));
  };
  gen();
  return card('mod-random', h2('div', { class: 'card-title' }, 'Random number'), out,
    h2('div', { class: 'row' }, 'From', lo, 'to', hi, h2('button', { class: 'btn mod-primary', onclick: gen }, 'Generate')));
}

function passwordCard() {
  let length = 20, symbols = true;
  const out = h2('div', { class: 'password' });
  const gen = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789' + (symbols ? '!@#$%^&*-_=+?' : '');
    const rnd = crypto.getRandomValues(new Uint32Array(length));
    out.textContent = Array.from(rnd, (n) => chars[n % chars.length]).join('');
  };
  const lenLabel = h2('span', {}, `${length} characters`);
  const slider = h2('input', { type: 'range', min: 8, max: 64, value: length, oninput: (e) => { length = +e.target.value; lenLabel.textContent = `${length} characters`; gen(); } });
  const copy = h2('button', { class: 'btn', onclick: () => { navigator.clipboard.writeText(out.textContent); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); } }, 'Copy');
  gen();
  return card('mod-random', h2('div', { class: 'card-title' }, 'Password'), out,
    h2('div', { class: 'row' }, h2('button', { class: 'btn mod-primary', onclick: gen }, 'New password'), copy, slider, lenLabel,
      h2('label', { class: 'check' }, h2('input', { type: 'checkbox', checked: symbols, onchange: (e) => { symbols = e.target.checked; gen(); } }), 'Symbols')));
}

function colorCard(hex) {
  const picker = h2('input', { type: 'color', value: hex || '#8a6cef' });
  const swatch = h2('div', { class: 'swatch' });
  const values = h2('div', { class: 'color-values' });
  const paint = () => {
    const v = picker.value;
    const r = parseInt(v.slice(1, 3), 16), g = parseInt(v.slice(3, 5), 16), b = parseInt(v.slice(5, 7), 16);
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2, d = max - min;
    const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    let hue = 0;
    if (d) hue = max === r / 255 ? ((g - b) / 255 / d) % 6 : max === g / 255 ? (b - r) / 255 / d + 2 : (r - g) / 255 / d + 4;
    swatch.style.background = v;
    values.replaceChildren(...[['HEX', v.toUpperCase()], ['RGB', `rgb(${r}, ${g}, ${b})`], ['HSL', `hsl(${Math.round(hue * 60 + 360) % 360}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`]]
      .map(([k, val]) => h2('button', { class: 'chip', title: 'Copy', onclick: () => navigator.clipboard.writeText(val) }, h2('b', {}, k + ' '), val)));
  };
  picker.addEventListener('input', paint);
  paint();
  return card('mod-color', h2('div', { class: 'card-title' }, 'Color'), h2('div', { class: 'row' }, swatch, picker, values));
}

// ------------------------------------------------------------ matching
function liveCard(raw) {
  const q = raw.trim().replace(/[?!.]+$/, '');
  const lq = q.toLowerCase();
  let m;

  if (/^(where am i|where i am|my location|my current location|current location|show (me )?my location|where am i right now)$/.test(lq)) return locationCard();
  if ((m = /^(?:map of|map|where is|directions to|show me|location of)\s+(.+)$/i.exec(q)) && !/^me\b/i.test(m[1])) return placeMapCard(m[1]);

  if (/^stop ?watch$/.test(lq)) return stopwatchCard();
  if ((m = /^(?:set (?:a )?)?timer(?: for)?\s*(.*)$/.exec(lq)) || (m = /^(.+?)\s+timer$/.exec(lq))) {
    const s = m[1] ? parseDuration(m[1]) : 0;
    if (s !== null) return timerCard(s);
  }
  if ((m = /^(?:set (?:a )?)?(?:countdown|alarm)(?: for)?\s*(.+)$/.exec(lq)) && parseDuration(m[1])) return timerCard(parseDuration(m[1]));

  if ((m = /^(?:weather|forecast)(?:\s+(?:in|for|at))?\s*(.*)$/.exec(lq)) || (m = /^(.+?)\s+(?:weather|forecast)$/.exec(lq))
    || (m = /^(?:what'?s|how'?s) the weather(?:\s+(?:like\s+)?(?:in|at))?\s*(.*)$/.exec(lq))) {
    return weatherCard(m[1] ? q.substr(lq.indexOf(m[1]), m[1].length) : '');
  }

  if ((m = /^(?:what(?:'s| is) the )?(?:current )?time(?: is it)?(?: now)?(?:\s+in\s+(.+))?$/.exec(lq)) || (m = /^(?:local )?time in (.+)$/.exec(lq)) || (m = /^(.+?) time$/.exec(lq))) {
    if (!m[1] || m[1].split(' ').length <= 4) return clockCard(m[1] ? q.substr(lq.indexOf(m[1]), m[1].length) : '');
  }
  if (/^(?:what(?:'s| is) )?(?:today'?s )?(?:date|day)(?: today| is it)?(?: today)?$/.test(lq) || lq === "what's today" || lq === 'today') return clockCard('');

  if ((m = /^(?:define|definition of|meaning of|dictionary)\s+([a-z' -]+)$/.exec(lq)) || (m = /^what does ([a-z' -]+) mean$/.exec(lq)) || (m = /^([a-z'-]+) (?:meaning|definition)$/.exec(lq))) {
    return defineCard(m[1].trim());
  }

  if (/^(flip a coin|coin flip|flip coin|toss a coin|coin toss|heads or tails)$/.test(lq)) return coinCard();
  if (/^(roll (a )?(die|dice)|dice roll|roll dice|dice)$/.test(lq)) return diceCard();
  if ((m = /^(?:random number|pick a number|rng)(?: (?:between|from) (-?\d+) (?:and|to) (-?\d+))?$/.exec(lq))) return randomCard(m[1] ? +m[1] : 1, m[2] ? +m[2] : 100);
  if (/^((generate|make|create) (a )?(strong |random )?password|password generator|random password|strong password)$/.test(lq)) return passwordCard();
  if ((m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(lq)) && /^#/.test(q)) {
    const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    return colorCard('#' + hex);
  }
  if (/^(color|colour) ?picker$/.test(lq)) return colorCard();

  // conversions: "10 km to miles", "100 usd in eur", "$50 to euros"
  if ((m = /^([$€£¥])?\s*(-?[\d.,]+)\s*([a-z$€£¥°"'/ 23]*?)\s+(?:to|in|into|as|=)\s+([a-z$€£¥°"'/ 23]+)$/i.exec(q))) {
    const n = parseFloat(m[2].replace(/,/g, ''));
    const fromWord = m[1] || m[3];
    const fromCur = currencyOf(fromWord), toCur = currencyOf(m[4]);
    if (fromCur && toCur) return currencyCard(n, fromCur, toCur);
    const fromU = unitOf(fromWord), toU = unitOf(m[4]);
    if (fromU && toU && fromU.dim === toU.dim) return unitCard(n, fromU, toU);
  }
  if (/^(currency converter|exchange rates?)$/.test(lq)) return currencyCard(1, 'USD', 'EUR');
  if (/^(unit converter|convert units)$/.test(lq)) return unitCard(1, unitOf('km'), unitOf('mi'));

  if (/^(calculator|calc)$/.test(lq)) return calculatorCard('');
  const expr = lq.replace(/^(?:what(?:'s| is)|calculate|solve|compute)\s+/, '');
  if (/[\d)]\s*[-+*/^%x×÷!]|^(sqrt|sin|cos|tan|log|ln)\(|%\s*of\s*\d/.test(expr) && calculate(expr) !== null) return calculatorCard(expr);

  return null;
}
