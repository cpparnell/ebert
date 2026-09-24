# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ebert is a Manifest V3 Chrome extension that injects Letterboxd ratings into The Criterion Channel (www.criterionchannel.com): a small badge on each browse card, and a detailed score line under the title on film/collection pages. It also badges every row of the all-films table at films.criterionchannel.com, where each row carries its own title/director/year, so rows need no page fetch (`ON_CATALOG` in `content.js`), and adds a "Letterboxd Rating" option to that page's sort menu plus a "Letterboxd" group to its Advanced Filters panel. With a Letterboxd username set in the toolbar popup, badges and the detail line also mark films the user has watched (with their rating, shown on the badge beside the consensus score) or has on their watchlist.

## Commands

There is no package.json, bundler, or linter. It's plain JS loaded directly by Chrome.

- **Run the unit tests:** `node --test` (Node's built-in runner picks up `tests/*.test.js`). They cover the pure `lib/` functions. Anything that touches the DOM or `chrome.*` is checked in the browser. Add tests for new `lib/` logic.
- **Run the extension:** load the repo root as an unpacked extension at `chrome://extensions` (Developer mode). After editing, click reload on the extension, then refresh the Criterion tab. A content script left over from the old version detects this (`chrome.runtime.id` is gone) and stops itself.
- **Build the shared snapshot locally:** `node scripts/build-snapshot.js [out=dist/snapshot.json]`. Use `LIMIT=50 node scripts/build-snapshot.js` for a quick partial run. Needs Node 22 for global `fetch`.
- **Debug card matching:** in DevTools on a Criterion page, each card has `data-ebert` with its outcome (`ok`, `no-criterion-meta`, `no-letterboxd-match`, `no-rating`, `deferred`, errors), plus `data-ebert-query` and `data-ebert-key`.

## Architecture

### Dual-environment `lib/` files
`lib/letterboxd.js`, `lib/criterion.js`, `lib/snapshot.js`, and `lib/user.js` run in three places: the content script (listed in `manifest.json`), the background service worker (`importScripts`), and Node (`require`, from `scripts/build-snapshot.js`). So:
- They share globals in the browser and end with a `if (typeof module !== "undefined") module.exports = …` block for Node. Add any new export needed by the build script there.
- No DOM APIs in them. The service worker and Node have no `DOMParser`, which is why HTML parsing uses regexes and JSON-LD.
- `lib/shared.js` (cache, `limiter`, `politeFetch`, `DAY_MS`) uses `chrome.*` and is **browser-only**. Node code must not depend on it.
- Script order matters: `manifest.json` content_scripts and the `importScripts` call in `background.js` load `shared.js` first, because the others use `DAY_MS` and similar globals at load time.

### Data flow
1. **Nightly snapshot** (`.github/workflows/snapshot.yml` → `scripts/build-snapshot.js`): scrapes the full catalog from `films.criterionchannel.com`, resolves each film on Letterboxd, and publishes `snapshot.json` to GitHub Pages (`SNAPSHOT_URL` in `lib/snapshot.js`). It reuses the previous snapshot's Letterboxd URLs, and refuses to publish if the catalog parses to fewer than 500 films or more than 10% of lookups fail. Films that `resolveFilm` can't match fall through to `scripts/wikidata.js` (below).
2. **Background worker** (`background.js`): syncs the snapshot hourly via alarm (at most every 6h, `no-cache` for ETag revalidation). It answers `{type: "lookup", film}` messages, checking the snapshot first and then running a live `resolveFilm` for snapshot misses, with per-film cache TTLs and in-flight dedup. Snapshot misses need live lookup because Letterboxd's search fallback needs the user's cookies (Cloudflare blocks it for the Action).
3. **User sync** (`lib/user.js`, `syncUser` in `background.js`): the popup (`popup.html`) stores a username under `user:name` and asks the worker to sync. The worker walks the user's public `/<user>/films/` and `/<user>/watchlist/` poster grids into `user` = `{username, watched: {lbSlug: rating|0}, watchlist: {lbSlug: 1}}`. These pages need no login, so no cookies are involved. The data is re-read every 3h on the hourly alarm, and `user:status` records the last outcome for the popup. Cards match on the Letterboxd slug in a result's `url` (`userMark`).
4. **Content script** (`content.js`): finds cards with a MutationObserver and IntersectionObserver. It gets Criterion metadata (title/year/directors) from the snapshot by slug, or by fetching and parsing the film's Criterion page. The Letterboxd result usually comes from its own copy of the snapshot; only a miss or a stale entry is messaged to the background (`lookup` in `content.js`), because waking a sleeping MV3 worker costs more than the round trip does.

### Caching
- `chrome.storage.local` is mirrored into memory (`cacheMem` in `lib/shared.js`) in every context, kept in sync via `storage.onChanged`, so first paint is synchronous (`cachePeek`).
- The mirror loads in two passes, because reading the whole store costs a visible pause — the snapshot alone is 600KB+ and the per-film `lb:`/`cc4:` entries grow without bound. `cacheReady` is the handful of `HOT_KEYS` first paint needs; `cacheFull` is the rest, read behind it. `cacheGet` awaits `cacheFull`, so an await-ing caller never reads a not-yet-loaded key as a miss; `cachePeek` may miss one during the backfill and simply takes a slower path to the same answer. `cacheOwn` keeps the backfill from overwriting anything written or changed since the read started. `HOT_KEYS` repeats key names that `lib/snapshot.js`, `lib/user.js` and `content.js` define, because `shared.js` loads first — add a key there if first paint starts needing it.
- The content script runs at `document_start` so that read is in flight while the page parses. Badges wait only on `cacheReady` and `DOMContentLoaded`; the catalog's sort and filter controls wait on `load` as well, since the site binds its own handlers at init and ours must go in after.
- Entries are `{v, exp}`. Expired entries are returned flagged `stale`, so the old value is shown while a refresh runs. `v: null` caches a miss.
- Key prefixes: `lb:<squashed title>|<year>` for Letterboxd results. `lbKey` is shared so every context computes the same key, and the snapshot is indexed by it too. `cc4:<path>` holds Criterion page metadata; bump the version number to invalidate. `catalog:filters` holds the catalog filter bar's state. `snapshot` holds the shared snapshot and `snapshot:checked` throttles syncing.
- `onInstalled` clears cached misses so an improved matcher can retry them.
- The content script repaints cards when `lb:*` or `snapshot` keys change, and repaints every badge when `user` or `user:name` changes. It ignores `user` data synced for a different username than `user:name`.

### Catalog sort
films.criterionchannel.com sorts on the server via `?sort=`/`?direction=`, and answers 500 to a `sort` value it doesn't know. So the Letterboxd sort reorders the table rows in place (`sortByRating` in `lib/criterion.js`) and is stored in the hash (`#letterboxd`, `#letterboxd-asc`). While it's active, capture-phase listeners in `setupRatingSort` intercept the site's sort select and direction button. When another sort is chosen, they strip the hash first, because the site builds its new URL by appending to `location.href`.

### Catalog filters
The catalog page ships all ~3,300 rows at once, so `setupFilters` in `content.js` narrows them with a class (`.ebert-hidden`) rather than a round trip. The controls are injected into the site's own Advanced Filters panel as its first group, ahead of Genres/Decades/Countries/Directors (`panel.prepend`, with `addPanelMenuItem` prepending to match in the panel's nav), and ask only what Letterboxd knows and that panel can't: minimum rating, runtime range, and the user's watched/watchlist state. Genre, decade, country and director stay the site's — these compose with them, since the site's filters navigate and ours survive the reload. The rules are pure functions in `lib/criterion.js` (`matchesFilters`, `normalizeFilters`, `inRuntimeRange`, `RUNTIME_MIN`/`RUNTIME_MAX`/`RUNTIME_STEP`), which is where tests for them go.
- Nothing here touches the site's filter logic. `StoreFilters` captures its checkboxes once at init (`.filter-group-option input[type=checkbox]`) and only those feed the query string Apply navigates to, so ours are added after that init and deliberately don't carry that class (they go first in the DOM, but still last in time) — Apply produces a clean `?decade=1960s`. Our options do reuse the panel's styling, which hides the checkbox and draws the dot as `label::before`. The site's Reset is hooked to clear ours too.
- Rating is a minimum; runtime is a two-handle range (`rangeSlider` in `content.js`) whose ends mean "and under" and "and over", so a handle resting on one is no bound there and the default pair is no filter at all. HTML has no two-handle slider, so it's two range inputs stacked on one track, each drawing only its thumb — which keeps native focus and arrow keys on both.
- Rating and runtime come from the Letterboxd result (snapshot or `lb:` cache), the watched state from `userMark`. A film missing the fact a filter asks about fails it, so an active filter never shows an unknown. The runtime control only appears once the snapshot carries runtimes.
- Filters persist under `catalog:filters` so they survive those reloads. Because they outlive the page — and the panel covers the table while it's open — a sticky status line appears above the table whenever a filter is on, carrying the count and a Clear, and a combination matching nothing renders an explicit empty state rather than a blank table.
- Panel CSS is specific: `.filters .filter-group h4` sets 20px, so our section titles need `.filters .ebert-filter-group h4.ebert-section-title` to win. The site's groups carry no padding of their own and sit 50px apart, so ours starts flush with the top of the panel and carries that same 50px below it.

### Matching (`lib/letterboxd.js`)
`resolveFilm` first tries candidate Letterboxd slugs (`slugify` mirrors Letterboxd's slug scheme, with year/article variants) and accepts a result on a director or ±1-year match. Failing that, it uses Letterboxd autocomplete search, which requires 2 of 3 signals (director, title, year) to agree. It strips "version" and "(a.k.a. …)" suffixes, and tries the parent title (slugs, then search) for series installments: "Part/Episode N" suffixes, or an all-caps series prefix like "GREEN PORNO: Anchovy".

### Wikidata fallback (`scripts/wikidata.js`) — build only
Cloudflare 403s Letterboxd's search for any non-browser client, so the nightly Action can only guess slugs — and a film Criterion lists under a title Letterboxd doesn't use is unreachable that way. "La piscine" is the example: Letterboxd has it at `/film/the-swimming-pool/`, and `/film/la-piscine/` is a *different* film that returns 200. That left ~194 of 3,300 films unmatched for everyone.

`resolveViaWikidata` fills the gap. Wikidata is keyless and unblocked, and records the Letterboxd slug itself (P6127) plus TMDB (P4947) and IMDb (P345) ids, which Letterboxd resolves via `/tmdb/<id>/` and `/imdb/<id>/` redirects. Two API calls per title (`wbsearchentities`, then `wbgetentities` for claims, plus one batched call for director labels), `rankCandidates` keeps only candidates agreeing with Criterion on year or director, and at most 3 are fetched from Letterboxd.

- **It only proposes; Letterboxd confirms.** Every candidate is fetched and checked by `acceptsFilm`, which uses `isSearchMatch` (2 of 3 signals), *not* the looser `isMatch` the slug path uses — a slug already encodes the title, a Wikidata label match doesn't.
- **The parent-title path also demands the titles match.** Director and years are shared across a whole franchise, so 2-of-3 alone matched every "GHOST IN THE SHELL: STAND ALONE COMPLEX" episode to Kamiyama's unrelated "Solid State Society" film. Tests cover this.
- This is Node-only and is **not** loaded by the extension, which has the user's cookies and so uses Letterboxd search directly. It's in `scripts/`, not `lib/`, for that reason. Tests are `tests/wikidata.test.js`.
- A Wikidata failure is caught and logged, never counted toward `MAX_ERROR_RATE`, so an outage degrades to the old behaviour instead of blocking the publish.
- `ONLY=la-piscine,xiao-wu node scripts/build-snapshot.js` resolves just those slugs — the way to debug one film's matching without waiting out the catalog.

### Rate limiting
`limiter(max)` in `lib/shared.js` runs tasks newest-first (LIFO, favoring what's on screen) and drops tasks whose `wanted()` returns false with `Cancelled`. Cards that scroll away are skipped this way. `politeFetch` backs off the whole limiter on 429/503. The build script has its own Node version, `politeFetcher(name)`, instantiated once per host (Letterboxd, Wikidata) so throttling on one never stalls the other.
