# Link

A private, extensible web browser with an Obsidian-style interface, built on Chromium (Electron).

## Install

Download the latest version from the [Releases page](https://github.com/Alex666afk/link-browser/releases/latest).

**Windows:** run `Link-Setup-x.y.z.exe` to install with Start-menu and desktop shortcuts, or run `Link-Portable-x.y.z.exe` without installing anything. Windows SmartScreen may warn that the app is unrecognized. Click **More info → Run anyway**.

**macOS:** download `Link-x.y.z-mac-arm64.dmg` for Apple-silicon Macs (M1 and later) or `Link-x.y.z-mac-x64.dmg` for Intel Macs, open it, and drag Link into Applications. Link isn't notarized by Apple, so the first time you open it macOS will say it can't verify the app. To open it, either
- open **System Settings → Privacy & Security** and click **Open Anyway** next to Link, or
- run `xattr -cr /Applications/Link.app` in Terminal once.

The Windows and Mac apps are built from the same code and have the same features.

## Develop

```
npm install
npm start          # run from source
npm run dist:win   # Windows installer + portable .exe into dist/
npm run dist:mac   # macOS .dmg + .zip (Intel and Apple silicon); must be run on a Mac
```

Pushing a tag like `v1.0.1` makes GitHub Actions build both the Windows and macOS apps and attach them to a release.

## Features

- **Link Search**: Link's own search engine and the default. It's built in, so there's nothing to set up. It shows ad-free web results, a knowledge panel, related searches and matches from your own bookmarks and history, and it goes through the VPN when that's on.
- **Live cards in Link Search**: interactive cards appear above the results for searches like `where am i` (map of your location), `map of paris`, `timer 10 min`, `stopwatch`, `12*(3+4)`, `10 km to miles`, `100 usd to eur`, `weather in tokyo`, `time in london`, `define serendipity`, `flip a coin`, `roll a dice`, `random number`, `generate password` and `#ff8800`.
- **Other search engines**: 12 more built in (DuckDuckGo, Google, Brave, Bing, Startpage, Ecosia, Qwant, Mojeek, Yahoo, YouTube, Wikipedia, GitHub), plus your own custom engines. Switch with one click from the engine button in the address bar, or search once with any engine using the logos under the suggestions.
- **Link Protect**: ad, tracker and malware blocking (EasyList, EasyPrivacy, uBlock Origin lists), optional cookie-banner blocking, HTTPS-only mode, Global Privacy Control, WebRTC leak protection and permission prompts.
- **VPN**: Link VPN is built in and free, with nothing to install. The first time you turn it on, Link downloads a Tor client from torproject.org, checks it against Tor's published checksum, and runs it in the background until Link quits. You can also use your own VPN provider's SOCKS5/HTTPS server. Either way, pages stop loading if the VPN drops, so your real IP never leaks. With Link VPN you can pick the country websites see you in. While the VPN is on, sites can't get your device's location and see the VPN country's time zone, and Google searches that hit Google's "I'm not a robot" wall open in Link Search instead.
- **Chrome extensions**: install from the Chrome Web Store ("Add to Link" button on extension pages), load unpacked folders, or import the ones you have in Chrome, Edge or Brave.
- **Import**: bookmarks, history and extensions from Chrome, Edge, Brave, Opera, Opera GX, Vivaldi, Arc, Chromium and Firefox. Bookmark HTML files from any browser. Password CSV exports from any browser, stored encrypted with your OS keychain.
- Vertical-tab-style sidebar (bookmarks, tabs, history, downloads), a command palette (`Ctrl+P`), a quick switcher (`Ctrl+E`), private tabs, find in page, zoom, and light, dark and system themes with an accent color.

## Layout

- `src/main/`: main process (window, sessions, protection, extensions, importer, passwords, storage)
- `src/preload/shell.js`: safe bridge between the UI and the main process
- `src/renderer/`: browser UI
- `src/pages/`: the `link://newtab` start page
- `assets/`: app icon (`icon.svg` is the source) and bundled search-engine logos
