// Link Search: Link's built-in search engine. Gathers web results and a knowledge panel
// directly from the main process (through the VPN when it is on). No setup required.
let ses;

const WEB = 'https://html.duckduckgo.com/html/';
const nextForms = new Map(); // `${query}|${page}` -> form fields for that page
const cache = new Map(); // `${query}|${page}` -> results, for back/forward and "More results"

const decode = (s) => s
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
  .replace(/\s+/g, ' ').trim();

function realUrl(href) {
  const h = href.replace(/&amp;/g, '&');
  const m = /[?&]uddg=([^&]+)/.exec(h);
  const url = m ? decodeURIComponent(m[1]) : h.startsWith('//') ? 'https:' + h : h;
  return /^https?:\/\//i.test(url) ? url : null;
}

function parseResults(html) {
  const results = [];
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const block of blocks) {
    if (/result--ad/.test(block.slice(0, 200))) continue; // sponsored
    const a = /class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = realUrl(a[1]);
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    results.push({ title: decode(a[2]), url, content: snippet ? decode(snippet[1]) : '' });
  }
  return results;
}

// The hidden fields of the "next page" form.
function parseNextForm(html) {
  const forms = html.match(/<form[^>]*action="\/html\/"[^>]*>[\s\S]*?<\/form>/g) || [];
  for (const form of forms.reverse()) {
    const fields = {};
    for (const m of form.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) fields[m[1]] = decode(m[2]);
    if (fields.s && fields.vqd) return fields;
  }
  return null;
}

async function fetchWeb(q, page) {
  const key = (p) => `${q}|${p}`;
  let res;
  if (page === 1) {
    res = await ses.fetch(`${WEB}?q=${encodeURIComponent(q)}&kp=-1`, { signal: AbortSignal.timeout(10000) });
  } else {
    if (!nextForms.has(key(page))) await fetchWeb(q, page - 1);
    const form = nextForms.get(key(page));
    if (!form) return [];
    res = await ses.fetch(WEB, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(10000),
    });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const next = parseNextForm(html);
  if (next) nextForms.set(key(page + 1), next);
  return parseResults(html);
}

// Knowledge panel from Wikipedia, shown when an article clearly matches the query.
async function fetchPanel(q) {
  try {
    const api = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json`;
    const hit = (await (await ses.fetch(api, { signal: AbortSignal.timeout(5000) })).json())?.query?.search?.[0];
    if (!hit) return null;
    const norm = (s) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    // Only when the article is clearly what you searched for ("octopus", "who is ada lovelace").
    const query = norm(q).replace(/^(who|what) (is|are|was|were) (the |a |an )?|^tell me about /, '');
    if (norm(hit.title) !== query) return null;
    const summary = await (await ses.fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`, { signal: AbortSignal.timeout(5000) })).json();
    if (!summary.extract || summary.type === 'disambiguation') return null;
    return {
      title: summary.title,
      description: summary.description || '',
      content: summary.extract,
      image: summary.thumbnail?.source || null,
      links: [{ title: 'Wikipedia', url: summary.content_urls?.desktop?.page }].filter((l) => l.url),
      attributes: [],
    };
  } catch { return null; }
}

async function search(q, page = 1) {
  const key = `${q}|${page}`;
  if (cache.has(key)) return cache.get(key);
  const [web, panel, related] = await Promise.all([
    fetchWeb(q, page).then((r) => ({ ok: r }), (err) => ({ err })),
    page === 1 ? fetchPanel(q) : null,
    page === 1 ? suggest(q) : [],
  ]);
  if (web.err) return { error: 'unavailable', results: [] };

  const seen = new Set();
  const results = web.ok.filter((r) => {
    const k = r.url.replace(/^https?:\/\/(www\.)?/, '').replace(/[/#?]+$/, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const data = { results, infobox: panel, suggestions: related.filter((s) => s.toLowerCase() !== q.toLowerCase()).slice(0, 8), answers: [], correction: null, hasMore: nextForms.has(`${q}|${page + 1}`) };
  cache.set(key, data);
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return data;
}

async function suggest(q) {
  try {
    const res = await ses.fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`, { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    return Array.isArray(data?.[1]) ? data[1] : [];
  } catch { return []; }
}

function init(session) { ses = session; }

module.exports = { init, search, suggest };
