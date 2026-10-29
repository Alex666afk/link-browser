// Settings modal (Obsidian-style vertical tabs) and first-run welcome.

const SETTINGS_TABS = [
  ['Options', [
    ['general', 'General', 'sliders'],
    ['search', 'Search engines', 'search'],
    ['appearance', 'Appearance', 'palette'],
    ['shortcuts', 'Keyboard shortcuts', 'keyboard'],
  ]],
  ['Privacy', [
    ['protection', 'Link Protect', 'shield'],
    ['vpn', 'VPN', 'globe-lock'],
    ['passwords', 'Passwords', 'key'],
  ]],
  ['Data', [
    ['extensions', 'Extensions', 'puzzle'],
    ['import', 'Import data', 'import'],
    ['about', 'About Link', 'info'],
  ]],
];

let settingsModal = null;

function openSettings(tabId = 'general') {
  if (settingsModal) settingsModal.close();
  const content = h('div', { class: 'vertical-tab-content' });
  const nav = h('div', { class: 'vertical-tab-header' });
  const select = (id) => {
    nav.querySelectorAll('.vertical-tab-nav-item').forEach((el) => el.classList.toggle('is-active', el.dataset.id === id));
    content.replaceChildren();
    content.scrollTop = 0;
    (PANES[id] || PANES.general)(content);
  };
  for (const [group, items] of SETTINGS_TABS) {
    nav.append(h('div', { class: 'vertical-tab-header-group' },
      h('div', { class: 'vertical-tab-header-group-title' }, group),
      items.map(([id, label, ic]) => h('div', { class: 'vertical-tab-nav-item', dataset: { id }, onclick: () => select(id) }, icon(ic, 16), label))));
  }
  settingsModal = openModal({ className: 'mod-settings', content: [nav, content], onClose: () => { settingsModal = null; } });
  select(tabId);
}

const rerender = (el, pane) => () => { el.replaceChildren(); PANES[pane](el); };

// ============================================================
const PANES = {
  general(el) {
    const s = state.settings;
    const homeInput = textInput(s.homepage === NEWTAB ? '' : s.homepage, (v) => setSettings({ homepage: v.trim() ? (/^[a-z]+:/i.test(v.trim()) ? v.trim() : 'https://' + v.trim()) : NEWTAB }), { placeholder: 'Link start page' });
    el.append(
      h('h2', {}, 'General'),
      h('p', { class: 'setting-intro' }, 'Startup, homepage and everyday behaviour.'),
      settingItem('Homepage', 'Page that opens in new tabs and with Alt+Home. Leave empty for the Link start page.', homeInput),
      settingItem('Restore tabs on startup', 'Reopen the tabs you had open last time (private tabs are never restored).', toggle(s.restoreTabs, (v) => setSettings({ restoreTabs: v }))),
      settingItem('Memory Saver', 'Tabs you haven’t opened for 15 minutes free their memory, and reload when you go back to them. Tabs playing sound and private tabs stay awake.', toggle(s.memorySaver, (v) => setSettings({ memorySaver: v }))),
      settingItem('Search suggestions', 'Show live suggestions from your search engine while you type in the address bar.', toggle(s.suggestions, (v) => setSettings({ suggestions: v }))),
      settingItem('Default browser', 'Open web links from other apps in Link.', btn('Make Link my default browser', async () => {
        await L.makeDefaultBrowser();
        notice(state.platform === 'win32' ? 'Choose Link under “Web browser” in the Windows settings that just opened.' : 'Link is now your default browser.', { timeout: 8000 });
      })),
      settingItem('Downloads folder', state.downloadsDir, btn('Open folder', () => L.downloads.open(state.downloadsDir))),
    );
  },

  // ----------------------------------------------------------
  search(el) {
    const s = state.settings;
    el.append(
      h('h2', {}, 'Search engines'),
      h('p', { class: 'setting-intro' }, 'Pick the engine Link uses, and add your own. You can also switch with one click from the engine button in the address bar, the logos under the address bar suggestions, or the start page.'),
      settingItem('Default search engine', 'Used for searches from the address bar and the start page.',
        dropdown(state.engines.map((e) => [e.id, e.name]), s.searchEngine, (v) => setSettings({ searchEngine: v }).then(rerender(el, 'search')))),
      settingHeading('Your engines'),
    );
    const list = h('div', { class: 'engine-list' });
    for (const e of state.engines) {
      const isDefault = e.id === s.searchEngine;
      list.append(h('div', { class: `card ${isDefault ? 'is-default' : ''}` },
        h('div', { class: 'card-icon' }, engineIcon(e, 20)),
        h('div', { class: 'card-body' },
          h('div', { class: 'card-title' }, e.name, isDefault ? h('span', { class: 'pill' }, 'Default') : null, e.builtin ? null : h('span', { class: 'pill mod-muted' }, 'Custom')),
          h('div', { class: 'card-sub' }, e.url)),
        h('div', { class: 'card-actions' },
          isDefault ? null : btn('Make default', () => setSettings({ searchEngine: e.id }).then(rerender(el, 'search'))),
          e.builtin ? null : h('button', { class: 'clickable-icon', title: 'Edit', onclick: () => engineForm(e) }, icon('pencil', 15)),
          e.builtin ? null : h('button', { class: 'clickable-icon', title: 'Remove', onclick: async () => {
            const patch = { customEngines: s.customEngines.filter((c) => c.id !== e.id) };
            if (isDefault) patch.searchEngine = 'duckduckgo';
            await setSettings(patch);
            rerender(el, 'search')();
          } }, icon('trash', 15)))));
    }
    el.append(list, h('div', { style: { marginTop: '14px', display: 'flex', gap: '8px' } },
      btn('Add search engine', () => engineForm(), 'mod-cta'),
      btn('Add from current site…', () => {
        const tab = activeTab();
        if (!tab || isInternal(tab.url)) return notice('Open a site that has a search results page first.');
        engineForm({ name: hostOf(tab.url).replace(/^www\./, ''), url: tab.url, fromCurrent: true });
      })));

    function engineForm(existing = null) {
      const editing = existing && existing.id;
      const name = textInput(existing?.name || '', null, { placeholder: 'My Search' });
      const url = textInput(existing?.url || '', null, { placeholder: 'https://example.com/search?q=%s' });
      const keyword = textInput(existing?.keyword || '', null, { placeholder: 'ms' });
      const suggest = textInput(existing?.suggest || '', null, { placeholder: 'Optional — OpenSearch JSON URL with %s' });
      const err = h('div', { class: 'result-line is-error' });
      const m = openModal({
        content: [
          h('div', { class: 'modal-title' }, editing ? 'Edit search engine' : 'Add search engine'),
          h('div', { class: 'setting-item-description' }, existing?.fromCurrent
            ? 'Search for something on this site, then copy its results URL here and replace your search words with %s.'
            : 'Use %s where the search words go. Tip: search for “test” on the site, copy the URL, and change test to %s.'),
          h('div', { class: 'form-grid' },
            h('label', {}, 'Name', name),
            h('label', {}, 'Shortcut (optional)', keyword),
            h('label', { class: 'span-2' }, 'Search URL', url),
            h('label', { class: 'span-2' }, 'Suggestions URL', suggest)),
          err,
          h('div', { class: 'modal-button-container' },
            btn('Cancel', () => m.close()),
            btn(editing ? 'Save' : 'Add engine', async () => {
              const u = url.value.trim();
              const kw = keyword.value.trim().replace(/^[@!]/, '').toLowerCase();
              if (!name.value.trim()) return (err.textContent = 'Give it a name.');
              if (!/^https?:\/\/.+%s/.test(u)) return (err.textContent = 'The URL must start with http(s):// and contain %s.');
              if (kw && state.engines.some((x) => x.keyword === kw && x.id !== existing?.id)) return (err.textContent = `@${kw} is already used by another engine.`);
              const entry = { id: editing ? existing.id : 'custom-' + Date.now().toString(36), name: name.value.trim(), url: u, keyword: kw, suggest: suggest.value.trim() };
              const customEngines = editing ? s.customEngines.map((c) => (c.id === entry.id ? entry : c)) : [...s.customEngines, entry];
              await setSettings({ customEngines });
              m.close();
              rerender(el, 'search')();
              notice(`${entry.name} ${editing ? 'updated' : 'added'}`, { type: 'success' });
            }, 'mod-cta')),
        ],
      });
    }
  },

  // ----------------------------------------------------------
  appearance(el) {
    const s = state.settings;
    const ACCENTS = ['#8a6cef', '#7c5cff', '#4f8ff7', '#24a8a8', '#44cf6e', '#e9973f', '#fb464c', '#e05ba8'];
    const swatches = h('div', { class: 'accent-swatches' },
      ACCENTS.map((c) => h('div', { class: `accent-swatch ${s.accent === c ? 'is-active' : ''}`, style: { background: c }, onclick: () => setSettings({ accent: c }).then(rerender(el, 'appearance')) })),
      h('input', { type: 'color', value: s.accent, onchange: (e) => setSettings({ accent: e.target.value }).then(rerender(el, 'appearance')) }));
    el.append(
      h('h2', {}, 'Appearance'),
      h('p', { class: 'setting-intro' }, 'Make Link look the way you like.'),
      settingItem('Base color scheme', 'Choose Link’s default color scheme.', dropdown([['dark', 'Dark'], ['light', 'Light'], ['system', 'Adapt to system']], s.theme, (v) => setSettings({ theme: v }))),
      settingItem('Accent color', 'Used for highlights, toggles and the active state.', swatches),
      settingItem('Show sidebar', 'The left panel with bookmarks, tabs, history and downloads (Ctrl+\\).', toggle(s.sidebarOpen, (v) => setSettings({ sidebarOpen: v }))),
    );
  },

  // ----------------------------------------------------------
  shortcuts(el) {
    const rows = COMMANDS.filter((c) => c[3]);
    el.append(
      h('h2', {}, 'Keyboard shortcuts'),
      h('p', { class: 'setting-intro' }, 'Every command is also in the command palette (Ctrl+P). On macOS use ⌘ instead of Ctrl.'),
      h('table', { class: 'shortcut-table' }, rows.map(([, name, , key]) => h('tr', {}, h('td', {}, name), h('td', {}, h('kbd', {}, key))))),
      h('table', { class: 'shortcut-table' },
        h('tr', {}, h('td', {}, 'Next / previous tab'), h('td', {}, h('kbd', {}, 'Ctrl+Tab'), ' ', h('kbd', {}, 'Ctrl+Shift+Tab'))),
        h('tr', {}, h('td', {}, 'Go to tab 1–8 / last tab'), h('td', {}, h('kbd', {}, 'Ctrl+1…8'), ' ', h('kbd', {}, 'Ctrl+9'))),
        h('tr', {}, h('td', {}, 'Back / forward'), h('td', {}, h('kbd', {}, 'Alt+←'), ' ', h('kbd', {}, 'Alt+→'))),
        h('tr', {}, h('td', {}, 'Fullscreen'), h('td', {}, h('kbd', {}, 'F11')))),
    );
  },

  // ----------------------------------------------------------
  protection(el) {
    const s = state.settings;
    el.append(
      h('h2', {}, 'Link Protect'),
      h('p', { class: 'setting-intro' }, `Link blocks ads and trackers before they load, using the same filter lists as uBlock Origin and EasyList. ${state.totalBlocked.toLocaleString()} requests blocked this session.`),
      settingItem('Block ads & trackers', 'Stops ads, tracking scripts, analytics and malware domains on every site.', toggle(s.adblock.enabled, (v) => setSettings({ adblock: { enabled: v } }))),
      settingItem('Blocking level', 'Strict also hides cookie banners, pop-ups and other annoyances.',
        dropdown([['ads', 'Basic — ads only'], ['adsAndTracking', 'Standard — ads & trackers'], ['full', 'Strict — ads, trackers & annoyances']], s.adblock.level, (v) => setSettings({ adblock: { level: v } }).then(() => notice('Filter lists updated — reload pages to apply')))),
      settingItem('HTTPS-only mode', 'Always upgrade connections to HTTPS. Falls back to HTTP only when a site has no secure version.', toggle(s.httpsOnly, (v) => setSettings({ httpsOnly: v }))),
      settingItem('Global Privacy Control & Do Not Track', 'Tell every website not to sell or share your personal data.', toggle(s.gpc, (v) => setSettings({ gpc: v }))),
      settingItem('Prevent WebRTC IP leaks', 'Stops sites from discovering your real IP address through WebRTC, even when the VPN is on. Applies to new tabs.', toggle(s.webrtcProtect, (v) => setSettings({ webrtcProtect: v }))),
      settingItem('Let sites ask for my location', 'Off: location requests are quietly refused, with no pop-up. Always refused while the VPN is on.', toggle(s.allowLocationPrompts, (v) => setSettings({ allowLocationPrompts: v }))),
      settingItem('Let sites ask to send notifications', 'Off: notification requests are quietly refused, with no pop-up.', toggle(s.allowNotificationPrompts, (v) => setSettings({ allowNotificationPrompts: v }))),
      settingItem('Ask before granting permissions', 'Camera, microphone, location, notifications and similar requests need your approval.', toggle(s.askPermissions, (v) => setSettings({ askPermissions: v }))),
      settingItem('Clear data when Link closes', 'Erase history, cookies, cache and saved tabs every time you quit.', toggle(s.clearOnExit, (v) => setSettings({ clearOnExit: v }))),
      settingHeading('Clear browsing data'),
    );
    const checks = { history: true, cookies: false, cache: true };
    el.append(
      h('div', { class: 'import-checks', style: { margin: '6px 0 10px' } },
        Object.entries({ history: 'Browsing history', cookies: 'Cookies & site data (signs you out)', cache: 'Cached images and files' }).map(([k, label]) => h('label', {},
          h('input', { type: 'checkbox', checked: checks[k], onchange: (e) => { checks[k] = e.target.checked; } }), label))),
      btn('Clear data now', async () => {
        await L.clearData(checks);
        notice('Browsing data cleared', { type: 'success' });
        if (state.settings.sidebarView === 'history') renderSidebar();
      }, 'mod-warning'),
    );
  },

  // ----------------------------------------------------------
  vpn(el) {
    const v = state.settings.vpn;
    const save = (patch) => setSettings({ vpn: patch });
    const status = h('div', { class: 'vpn-hero' },
      h('div', { class: `vpn-orb ${v.enabled ? 'is-on' : ''}` }, icon('globe-lock', 22)),
      h('div', { style: { flex: 1 } },
        h('div', { class: 'vpn-status-title' }, v.enabled ? `Protected via ${vpnLabel()}` : 'VPN is off'),
        h('div', { class: 'vpn-status-sub', id: 'vpn-ip' }, 'Press “Test connection” to see the IP address sites see.')),
      btn('Test connection', async () => {
        const out = document.getElementById('vpn-ip');
        out.textContent = 'Checking…';
        const r = await refreshVpnInfo();
        out.textContent = r.error ? 'Could not connect through this route.' : `${r.ip} · ${[r.city, r.country].filter(Boolean).join(', ')}${r.isp ? ' · ' + r.isp : ''}`;
      }));
    el.append(
      h('h2', {}, 'VPN'),
      h('p', { class: 'setting-intro' }, 'Hide your real IP address from websites by sending all of Link’s traffic through Link VPN or your own VPN server. If the connection drops, pages stop loading instead of leaking your real IP.'),
      status,
      settingItem('Enable VPN', 'Applies to every tab, including private tabs, extensions and downloads.', toggle(v.enabled, (on) => save({ enabled: on }).then(() => { state.vpnInfo = null; rerender(el, 'vpn')(); }))),
      settingItem('Route', 'How your traffic leaves your computer.', dropdown([['tor', 'Link VPN (free, built in)'], ['custom', 'My VPN / proxy server'], ['pac', 'PAC script (advanced)']], v.mode, (mode) => save({ mode }).then(rerender(el, 'vpn')))),
    );

    if (v.mode === 'tor') {
      el.append(
        h('div', { class: 'callout' },
          h('b', {}, 'Link VPN is built in and free. '), 'Just turn it on — there’s nothing to install or sign up for. It sends your traffic through three encrypted relays run by volunteers around the world (the Tor network), so no single server knows both who you are and what you visit. The first time, Link takes about 20 MB to set it up. It’s slower than a paid VPN, and some sites (especially Google) may ask you to solve a captcha.'),
        settingItem('Country', 'Choose where websites think you are. “Fastest” picks automatically; a specific country can be slower.',
          dropdown(VPN_COUNTRIES, v.country || '', (country) => { state.vpnInfo = null; save({ country }).then(rerender(el, 'vpn')); })),
        settingItem('Skip the VPN on sites that block it', 'When a site refuses VPN connections or breaks over them, Link opens it directly instead and lists it below. Those sites see your real IP address. Search engines always stay on the VPN.',
          toggle(v.autoBypass, (on) => save({ autoBypass: on }))),
        settingItem('Hide my location too', 'While the VPN is on, websites can’t get your device’s location. If a search engine blocks VPN connections, Link shows the search in Link Search instead.'),
      );
    }
    if (v.bypass?.length) {
      el.append(settingHeading('Sites that skip the VPN'),
        h('p', { class: 'setting-intro' }, 'These sites block VPN connections, so they open directly. They can see your real IP address.'),
        h('div', { class: 'card-list' }, v.bypass.map((host) => h('div', { class: 'card' },
          h('div', { class: 'card-icon' }, faviconEl('https://' + host, 'globe', 18)),
          h('div', { class: 'card-body' }, h('div', { class: 'card-title' }, host)),
          h('div', { class: 'card-actions' }, btn('Use VPN again', () => save({ bypass: v.bypass.filter((x) => x !== host) }).then(rerender(el, 'vpn'))))))));
    }
    if (v.mode === 'custom') {
      const type = dropdown([['socks5', 'SOCKS5'], ['http', 'HTTP'], ['https', 'HTTPS']], v.type, (t) => save({ type: t }));
      el.append(
        h('div', { class: 'callout' },
          h('b', {}, 'Works with most VPN providers. '), 'Mullvad, NordVPN, Proton VPN, Surfshark, PIA, IPVanish, Windscribe and others give you a SOCKS5 or HTTPS proxy address in their account dashboard. Enter it below — your other apps stay on your normal connection.'),
        h('div', { class: 'form-grid' },
          h('label', {}, 'Protocol', type),
          h('label', {}, 'Server address', textInput(v.host, (x) => save({ host: x.trim() }), { placeholder: 'e.g. nl.socks.nordhold.net' })),
          h('label', {}, 'Port', textInput(v.port, (x) => save({ port: x.trim() }), { placeholder: '1080' })),
          h('label', {}, 'Username (optional)', textInput(v.username, (x) => save({ username: x }), { placeholder: 'service username' })),
          h('label', { class: 'span-2' }, 'Password (optional — stored encrypted)', textInput('', (x) => save({ password: x }), { type: 'password', placeholder: v.password ? '•••••••• (saved)' : 'service password' }))),
      );
    }
    if (v.mode === 'pac') {
      el.append(settingItem('PAC script URL', 'A proxy auto-config file from your network administrator or VPN provider.', textInput(v.pac, (x) => save({ pac: x.trim() }), { placeholder: 'https://example.com/proxy.pac' })));
    }
  },

  // ----------------------------------------------------------
  async passwords(el) {
    const list = await L.passwords.list();
    let query = '';
    const search = h('input', { class: 'text', placeholder: 'Search passwords…', style: { width: '100%' } });
    const cards = h('div', { class: 'card-list' });
    const render = () => {
      const q = query.toLowerCase();
      const shown = list.filter((p) => !q || (p.name + p.url + p.username).toLowerCase().includes(q));
      cards.replaceChildren(...(shown.length ? shown.map((p) => {
        const secret = h('span', {}, '••••••••');
        let revealed = false;
        return h('div', { class: 'card' },
          h('div', { class: 'card-icon' }, faviconEl(p.url, 'key', 18)),
          h('div', { class: 'card-body' },
            h('div', { class: 'card-title' }, p.name),
            h('div', { class: 'card-sub' }, `${p.username || '(no username)'} · `, secret)),
          h('div', { class: 'card-actions' },
            h('button', { class: 'clickable-icon', title: 'Show password', onclick: async (e) => {
              revealed = !revealed;
              secret.textContent = revealed ? await L.passwords.reveal(p.id) : '••••••••';
              setIcon(e.currentTarget, revealed ? 'eye-off' : 'eye', 15);
            } }, icon('eye', 15)),
            h('button', { class: 'clickable-icon', title: 'Copy username', onclick: () => { navigator.clipboard.writeText(p.username); notice('Username copied'); } }, icon('copy', 15)),
            h('button', { class: 'clickable-icon', title: 'Copy password', onclick: async () => { navigator.clipboard.writeText(await L.passwords.reveal(p.id)); notice('Password copied'); } }, icon('key', 15)),
            h('button', { class: 'clickable-icon', title: 'Delete', onclick: async () => {
              if (await confirmDialog('Delete password', `Delete the saved password for ${p.username || p.name}?`, 'Delete')) { await L.passwords.remove(p.id); rerender(el, 'passwords')(); }
            } }, icon('trash', 15))));
      }) : [h('div', { class: 'empty-state' }, list.length ? 'No matches.' : 'No saved passwords. Import them from another browser below.')]));
    };
    search.addEventListener('input', () => { query = search.value; render(); });
    el.append(
      h('h2', {}, 'Passwords'),
      h('p', { class: 'setting-intro' }, 'Passwords are encrypted with your operating system’s secure storage. When a page has a saved login, a key icon appears next to the address bar — click it to fill the form.'),
      h('div', { style: { display: 'flex', gap: '8px', marginBottom: '8px' } },
        search,
        btn('Import CSV…', async () => {
          try {
            const r = await L.importer.file('passwords');
            if (r) { notice(`Imported ${r.passwords} passwords`, { type: 'success' }); rerender(el, 'passwords')(); }
          } catch (err) { notice(cleanError(err), { type: 'error', timeout: 8000 }); }
        }),
        btn('Add', () => addPassword(), 'mod-cta')),
      cards,
    );
    render();

    function addPassword() {
      const url = textInput('', null, { placeholder: 'https://example.com' });
      const user = textInput('', null, { placeholder: 'username or email' });
      const pass = textInput('', null, { type: 'password', placeholder: 'password' });
      const m = openModal({
        content: [
          h('div', { class: 'modal-title' }, 'Add password'),
          h('div', { class: 'form-grid' }, h('label', { class: 'span-2' }, 'Website', url), h('label', {}, 'Username', user), h('label', {}, 'Password', pass)),
          h('div', { class: 'modal-button-container' }, btn('Cancel', () => m.close()), btn('Save', async () => {
            if (!url.value || !pass.value) return notice('Website and password are required.');
            const site = /^https?:/.test(url.value) ? url.value : 'https://' + url.value;
            await L.passwords.add({ url: site, name: hostOf(site), username: user.value, password: pass.value });
            m.close();
            rerender(el, 'passwords')();
          }, 'mod-cta')),
        ],
      });
    }
  },

  // ----------------------------------------------------------
  async extensions(el) {
    const list = await L.extensions.list();
    const idInput = h('input', { class: 'text', placeholder: 'Paste a Chrome Web Store link or extension ID', style: { flex: 1 } });
    const install = async () => {
      if (!idInput.value.trim()) return;
      await installFromStore(idInput.value.trim());
      rerender(el, 'extensions')();
    };
    idInput.addEventListener('keydown', (e) => e.key === 'Enter' && install());
    el.append(
      h('h2', {}, 'Extensions'),
      h('p', { class: 'setting-intro' }, 'Link runs Chrome extensions. Browse the ', h('span', { class: 'link-text', onclick: () => { settingsModal?.close(); createTab({ url: 'https://chromewebstore.google.com/' }); } }, 'Chrome Web Store'),
        ' and press the purple “Add to Link” button next to the address bar on any extension page — or paste its link here.'),
      h('div', { style: { display: 'flex', gap: '8px' } }, idInput, btn('Install', install, 'mod-cta'), btn('Load unpacked…', async () => {
        try {
          const ext = await L.extensions.loadUnpacked();
          if (ext) { notice(`Loaded ${ext.name}`, { type: 'success' }); rerender(el, 'extensions')(); }
        } catch (err) { notice(cleanError(err), { type: 'error' }); }
      })),
      h('div', { class: 'callout mod-warning' }, 'Most content extensions (ad blockers, password managers, dark mode, translators, userscripts) work. A few that rely on Chrome-only browser APIs may be limited in Link.'),
      settingHeading(`Installed (${list.length})`),
    );
    const cards = h('div', { class: 'card-list' }, list.length ? list.map((ext) => h('div', { class: 'card' },
      h('div', { class: 'card-icon' }, ext.icon ? h('img', { src: ext.icon }) : icon('puzzle', 18)),
      h('div', { class: 'card-body' },
        h('div', { class: 'card-title' }, ext.name, h('span', { class: 'pill mod-muted' }, ext.version || ''), ext.source ? h('span', { class: 'pill mod-muted' }, ext.source) : null),
        h('div', { class: 'card-sub', style: { fontFamily: 'var(--font-ui)' } }, ext.description || ext.id)),
      h('div', { class: 'card-actions' },
        ext.options && ext.loaded ? h('button', { class: 'clickable-icon', title: 'Options', onclick: () => L.extensions.open(ext.id, 'options') }, icon('settings', 15)) : null,
        h('button', { class: 'clickable-icon', title: 'Remove', onclick: async () => {
          if (await confirmDialog('Remove extension', `Remove ${ext.name} from Link?`, 'Remove')) { await L.extensions.remove(ext.id); rerender(el, 'extensions')(); }
        } }, icon('trash', 15)),
        toggle(ext.enabled, async (on) => {
          try { await L.extensions.toggle(ext.id, on); } catch (err) { notice(cleanError(err), { type: 'error' }); }
        })))) : h('div', { class: 'empty-state' }, 'No extensions yet.'));
    el.append(cards);
  },

  // ----------------------------------------------------------
  async import(el) {
    el.append(
      h('h2', {}, 'Import data'),
      h('p', { class: 'setting-intro' }, 'Bring your bookmarks, history, extensions and passwords from any browser. For best results, close the other browser first.'),
      settingHeading('Browsers on this computer'),
    );
    const sources = await L.importer.detect();
    const box = h('div', { class: 'card-list' });
    if (!sources.length) box.append(h('div', { class: 'empty-state' }, 'No other browsers found. You can still import files below.'));
    for (const src of sources) box.append(importCard(src));
    el.append(box,
      state.platform === 'darwin' ? settingItem('Safari tabs', 'Open every tab you have open in Safari here. Safari needs to be open; macOS asks you to allow this the first time.', btn('Bring over tabs', bringSafariTabs, 'mod-cta')) : null,
      settingHeading('Import from a file'),
      settingItem('Bookmarks HTML file', 'Every browser can export bookmarks as an HTML file — Safari, Firefox, Chrome, Edge, Opera and more.', btn('Choose file…', async () => {
        try {
          const r = await L.importer.file('bookmarks');
          if (r) notice(`Imported ${r.bookmarks} bookmarks`, { type: 'success' });
        } catch (err) { notice(cleanError(err), { type: 'error' }); }
      })),
      settingItem('Passwords CSV file', h('span', {}, 'Export passwords from your old browser first: ', h('b', {}, 'Chrome/Edge/Brave'), ' → Settings → Passwords → Export · ', h('b', {}, 'Firefox'), ' → about:logins → ⋯ → Export · ', h('b', {}, 'Safari'), ' → File → Export → Passwords. Delete the CSV after importing.'),
        btn('Choose file…', async () => {
          try {
            const r = await L.importer.file('passwords');
            if (r) notice(`Imported ${r.passwords} passwords`, { type: 'success' });
          } catch (err) { notice(cleanError(err), { type: 'error', timeout: 8000 }); }
        })),
    );
  },

  // ----------------------------------------------------------
  about(el) {
    el.append(
      h('div', { class: 'about-hero' },
        appLogo(56),
        h('div', {}, h('h2', {}, 'Link'), h('div', { class: 'setting-item-description' }, `Version ${state.versions.app} · Chromium ${state.versions.chrome} · Electron ${state.versions.electron}`))),
      h('p', { class: 'setting-intro' }, 'A private, extensible browser. Built-in ad & tracker blocking, VPN routing, your choice of search engines, Chrome extensions and one-click import from any browser.'),
      settingItem('Ad-blocking engine', '@ghostery/adblocker with EasyList, EasyPrivacy, uBlock Origin and Peter Lowe’s lists.'),
      settingItem('Data folder', 'Your settings, bookmarks and history are stored only on this computer.'),
    );
  },
};

function importCard(src, compact = false) {
  const types = src.kind === 'safari' ? { bookmarks: true, history: true, cookies: true } : { bookmarks: true, history: true, extensions: src.kind === 'chromium' };
  const result = h('div');
  const button = btn('Import', async () => {
    const chosen = Object.keys(types).filter((k) => types[k]);
    if (!chosen.length) return;
    button.disabled = true;
    button.textContent = 'Importing…';
    try {
      const r = await L.importer.run(src, chosen);
      const parts = [];
      if (chosen.includes('bookmarks')) parts.push(`${r.bookmarks} bookmarks`);
      if (chosen.includes('history')) parts.push(`${r.history.toLocaleString()} history entries`);
      if (chosen.includes('extensions')) parts.push(`${r.extensions} extensions`);
      if (chosen.includes('cookies')) parts.push(`${r.cookies.toLocaleString()} cookies (you stay signed in to those sites)`);
      result.replaceChildren(
        h('div', { class: 'result-line' }, '✓ Imported ' + parts.join(', ')),
        ...r.errors.map((e) => h('div', { class: 'result-line is-error' }, e)),
        r.needsFullDiskAccess ? h('div', { class: 'result-line' }, btn('Open Full Disk Access settings', () => L.importer.fullDiskAccess())) : null,
        r.extensionErrors.length ? h('div', { class: 'result-line is-error' }, `${r.extensionErrors.length} extension(s) could not be loaded.`) : null);
      button.textContent = 'Import again';
    } catch (err) {
      result.replaceChildren(h('div', { class: 'result-line is-error' }, cleanError(err)));
      button.textContent = 'Import';
    }
    button.disabled = false;
  }, 'mod-cta');
  return h('div', { class: 'card import-source' },
    h('div', { class: 'card-icon' }, src.icon ? h('img', { src: src.icon, width: 24, height: 24 }) : src.name[0]),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-title' }, src.name, src.profile ? h('span', { class: 'pill mod-muted' }, src.profile) : null),
      compact ? null : h('div', { class: 'card-sub', title: src.path }, src.path),
      h('div', { class: 'import-checks' }, Object.keys(types).map((k) => (k === 'extensions' && src.kind !== 'chromium') ? null : h('label', {},
        h('input', { type: 'checkbox', checked: types[k], onchange: (e) => { types[k] = e.target.checked; } }), k[0].toUpperCase() + k.slice(1)))),
      result),
    h('div', { class: 'card-actions' }, button));
}

// ============================================================
// First-run welcome
// ============================================================
async function openWelcome() {
  const grid = h('div', { class: 'engine-grid' });
  const paint = () => grid.replaceChildren(...state.engines.filter((e) => e.builtin).slice(0, 8).map((e) => h('div', {
    class: `engine-choice ${e.id === state.settings.searchEngine ? 'is-active' : ''}`,
    onclick: async () => { await setSettings({ searchEngine: e.id }); paint(); },
  }, engineIcon(e, 24), e.name)));
  paint();
  const sources = await L.importer.detect();
  const finish = () => { setSettings({ onboarded: true }); m.close(); focusAddress(); };
  const m = openModal({
    className: 'mod-welcome',
    dismissable: false,
    closeButton: false,
    content: [
      h('div', { class: 'welcome-hero' },
        appLogo(48),
        h('div', {}, h('h1', {}, 'Welcome to Link'), h('p', {}, 'Ads and trackers are blocked by default. Pick a search engine and bring over your data to get started.'))),
      h('div', { class: 'welcome-step-title' }, '1 · Choose your search engine'),
      grid,
      h('div', { class: 'setting-item-description', style: { marginTop: '6px' } }, 'You can add your own engines later in Settings → Search engines.'),
      h('div', { class: 'welcome-step-title' }, '2 · Bring your stuff'),
      sources.length
        ? h('div', { class: 'card-list' }, sources.slice(0, 4).map((s) => importCard(s, true)))
        : h('div', { class: 'setting-item-description' }, 'No other browsers found — you can import a bookmarks file later from Settings → Import data.'),
      h('div', { class: 'modal-button-container' }, btn('Start browsing', finish, 'mod-cta')),
    ],
  });
}
