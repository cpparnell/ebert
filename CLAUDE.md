# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ebert is a Manifest V3 Chrome extension that injects Letterboxd ratings into The Criterion Channel (www.criterionchannel.com): a small badge on each browse card, and a detailed score line under the title on film/collection pages. It also badges every row of the all-films table at films.criterionchannel.com, where each row carries its own title/director/year, so rows need no page fetch (`ON_CATALOG` in `content.js`).

## Commands

There is no package.json, bundler, linter, or test suite. It's plain JS loaded directly by Chrome.

- **Run the extension:** load the repo root as an unpacked extension at `chrome://extensions` (Developer mode). After editing, click reload on the extension, then refresh the Criterion tab. A content script left over from the old version detects this (`chrome.runtime.id` is gone) and stops itself.
- **Build the shared snapshot locally:** `node scripts/build-snapshot.js [out=dist/snapshot.json]`. Use `LIMIT=50 node scripts/build-snapshot.js` for a quick partial run. Needs Node 22 for global `fetch`.
- **Debug card matching:** in DevTools on a Criterion page, each card has `data-ebert` with its outcome (`ok`, `no-criterion-meta`, `no-letterboxd-match`, `no-rating`, `deferred`, errors), plus `data-ebert-query` and `data-ebert-key`.

## Architecture

### Dual-environment `lib/` files
`lib/letterboxd.js`, `lib/criterion.js`, and `lib/snapshot.js` run in three places: the content script (listed in `manifest.json`), the background service worker (`importScripts`), and Node (`require`, from `scripts/build-snapshot.js`). So:
- They share globals in the browser and end with a `if (typeof module !== "undefined") module.exports = …` block for Node. Add any new export needed by the build script there.
- No DOM APIs in them. The service worker and Node have no `DOMParser`, which is why HTML parsing uses regexes and JSON-LD.
- `lib/shared.js` (cache, `limiter`, `politeFetch`, `DAY_MS`) uses `chrome.*` and is **browser-only**. Node code must not depend on it.
- Script order matters: `manifest.json` content_scripts and the `importScripts` call in `background.js` load `shared.js` first, because the others use `DAY_MS` and similar globals at load time.

### Data flow
1. **Nightly snapshot** (`.github/workflows/snapshot.yml` → `scripts/build-snapshot.js`): scrapes the full catalog from `films.criterionchannel.com`, resolves each film on Letterboxd, and publishes `snapshot.json` to GitHub Pages (`SNAPSHOT_URL` in `lib/snapshot.js`). It reuses the previous snapshot's Letterboxd URLs, and refuses to publish if the catalog parses to fewer than 500 films or more than 10% of lookups fail.
2. **Background worker** (`background.js`): syncs the snapshot hourly via alarm (at most every 6h, `no-cache` for ETag revalidation). It answers `{type: "lookup", film}` messages, checking the snapshot first and then running a live `resolveFilm` for snapshot misses, with per-film cache TTLs and in-flight dedup. Snapshot misses need live lookup because Letterboxd's search fallback needs the user's cookies (Cloudflare blocks it for the Action).
3. **Content script** (`content.js`): finds cards with a MutationObserver and IntersectionObserver. It gets Criterion metadata (title/year/directors) from the snapshot by slug, or by fetching and parsing the film's Criterion page. Then it messages the background for the Letterboxd result and renders the badge.

### Caching
- `chrome.storage.local` is mirrored into memory (`cacheMem` in `lib/shared.js`) in every context, kept in sync via `storage.onChanged`, so first paint is synchronous (`cachePeek`).
- Entries are `{v, exp}`. Expired entries are returned flagged `stale`, so the old value is shown while a refresh runs. `v: null` caches a miss.
- Key prefixes: `lb:<squashed title>|<year>` for Letterboxd results. `lbKey` is shared so every context computes the same key, and the snapshot is indexed by it too. `cc4:<path>` holds Criterion page metadata; bump the version number to invalidate. `snapshot` holds the shared snapshot and `snapshot:checked` throttles syncing.
- `onInstalled` clears cached misses so an improved matcher can retry them.
- The content script repaints cards when `lb:*` or `snapshot` keys change.

### Matching (`lib/letterboxd.js`)
`resolveFilm` first tries candidate Letterboxd slugs (`slugify` mirrors Letterboxd's slug scheme, with year/article variants) and accepts a result on a director or ±1-year match. Failing that, it uses Letterboxd autocomplete search, which requires 2 of 3 signals (director, title, year) to agree. It strips "version" and "(a.k.a. …)" suffixes, and tries the parent title (slugs, then search) for series installments: "Part/Episode N" suffixes, or an all-caps series prefix like "GREEN PORNO: Anchovy".

### Rate limiting
`limiter(max)` in `lib/shared.js` runs tasks newest-first (LIFO, favoring what's on screen) and drops tasks whose `wanted()` returns false with `Cancelled`. Cards that scroll away are skipped this way. `politeFetch` backs off the whole limiter on 429/503. The build script has its own Node version of `politeFetch`.
