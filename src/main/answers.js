// Data for Link Search's live cards (location, weather, time, currency, definitions).
// Free services that need no account; fetched from the main process so pages never call them directly.
const { net } = require('electron');
const protection = require('./protection');

let ses;
const getJson = async (url, { direct = false, timeout = 8000 } = {}) => {
  const res = await (direct ? net : ses).fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// Your approximate location from your internet connection. Uses the real connection, not the VPN,
// because "where am I" means where you actually are.
async function location() {
  const d = await getJson('https://ipwho.is/', { direct: true });
  if (d.success === false) throw new Error(d.message || 'Location unavailable');
  return { lat: d.latitude, lon: d.longitude, city: d.city, region: d.region, country: d.country, flag: d.flag?.emoji, timezone: d.timezone?.id };
}

async function place(name) {
  const d = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
  const p = d.results?.[0];
  if (!p) return null;
  return { name: p.name, region: p.admin1, country: p.country, lat: p.latitude, lon: p.longitude, timezone: p.timezone };
}

async function weather(name) {
  const where = name ? await place(name) : await location().then((l) => ({ name: l.city, region: l.region, country: l.country, lat: l.lat, lon: l.lon }));
  if (!where) return { error: 'notfound' };
  const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${where.lat}&longitude=${where.lon}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=5');
  return { place: where, current: w.current, daily: w.daily };
}

async function time(name) {
  const p = await place(name);
  return p ? { place: p } : { error: 'notfound' };
}

async function currency(amount, from, to) {
  const d = await getJson(`https://api.frankfurter.app/latest?amount=${encodeURIComponent(amount)}&from=${from}&to=${to}`);
  if (!d.rates?.[to]) return { error: 'unsupported' };
  return { amount: d.amount, from, to, result: d.rates[to], date: d.date };
}

async function define(word) {
  try {
    const d = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    const e = d[0];
    return {
      word: e.word,
      phonetic: e.phonetic || e.phonetics?.find((p) => p.text)?.text || '',
      audio: e.phonetics?.find((p) => p.audio)?.audio || null,
      meanings: e.meanings.slice(0, 3).map((m) => ({
        partOfSpeech: m.partOfSpeech,
        definitions: m.definitions.slice(0, 3).map((x) => ({ definition: x.definition, example: x.example || null })),
        synonyms: (m.synonyms || []).slice(0, 6),
      })),
    };
  } catch { return { error: 'notfound' }; }
}

// Routes /api/answer/<kind>?... from the Link Search page.
async function handle(kind, params) {
  try {
    switch (kind) {
      case 'location': {
        // With the VPN on, show where websites now see you; your real location only on request.
        const vpn = protection.getVpnLocation();
        if (vpn && params.get('real') !== '1') return { ...vpn, viaVpn: true };
        return await location();
      }
      case 'weather': return await weather(params.get('place') || '');
      case 'time': return await time(params.get('place') || '');
      case 'currency': return await currency(params.get('amount'), params.get('from'), params.get('to'));
      case 'define': return await define(params.get('word') || '');
      default: return { error: 'unknown' };
    }
  } catch (err) {
    return { error: 'unavailable', message: err.message };
  }
}

function init(session) { ses = session; }

module.exports = { init, handle };
