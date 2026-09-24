# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ebert is a Manifest V3 Chrome extension that injects Letterboxd ratings into The Criterion Channel (www.criterionchannel.com): a small badge on each film card (browse rails, collections, All Films), and a detailed score line under the title on film and series pages. With a Letterboxd username set in the toolbar popup, badges and the detail line also mark films the user has watched (with their rating, shown on the badge beside the consensus score) or has on their watchlist.

## Commands

There is no package.json, bundler, or linter. It's plain JS loaded directly by Chrome.

- **Run the unit tests:** `node --test` (Node's built-in runner picks up `tests/*.test.js`). One file is `node --test tests/criterion.test.js`; one case is `node --test --test-name-pattern "sortByRating"`. They cover the pure `lib/` functions (plus `scripts/wikidata.js`); anything that touches the DOM or `chrome.*` is checked in the browser. Add tests for new `lib/` logic.
- **Run the extension:** load the repo root as an unpacked extension at `chrome://extensions` (Developer mode). After editing, click reload on the extension, then refresh the Criterion tab. A content script left over from the old version detects this (`chrome.runtime.id` is gone) and stops itself.
- **Build the shared snapshot locally:** `node scripts/build-snapshot.js [out=dist/snapshot.json]`. Use `LIMIT=50 node scripts/build-snapshot.js` for a quick partial run. Needs Node 22 for global `fetch`.
- **Debug card matching:** in DevTools on a Criterion page, each card has `data-ebert` with its outcome (`ok`, `not-a-film`, `no-criterion-meta`, `no-letterboxd-match`, `no-rating`, `deferred`, errors), plus `data-ebert-query` and `data-ebert-key`.

## When Criterion changes its site

Everything that depends on how criterionchannel.com is built lives in `lib/site.js`: the DOM locators (`SELECTORS`), the state classes our copies of its controls toggle (`STATE_CLASSES`), its URLs (`FILM_PATH`/`criterionId`, `filmHref`, `posterUrl`, `ALL_FILMS_PATH`), and the JSON API (`mediaUrl`/`parseMedia`, `allFilmsUrl`/`parseAllFilms`). Nothing else should name a Criterion class, path or endpoint — `content.css` positions the badge against our own `.ebert-anchor` class, which `content.js` adds to whatever `SELECTORS.cardImage` matches.
- The site is Next.js with CSS modules, so classes look like `PlaylistCard-module-less-module__Xfr99W__card`. The hash changes on every deploy of theirs; `cssModule(component, element)` matches the stable parts, anchored at both ends (`__title` must not catch `__titleRow`). Find the new names in DevTools and update `SELECTORS`.
- Film metadata (title, year, directors) comes from `/api/media/<id>`, not the page, so a redesign that keeps the API only needs new selectors. `tests/site.test.js` pins the API shapes.
- Check in the browser for React error #418 after any change to when or where we draw: see "Hydration" below.

## Architecture

### Dual-environment `lib/` files
`lib/letterboxd.js`, `lib/site.js`, `lib/snapshot.js`, and `lib/user.js` run in up to three places: the content script (listed in `manifest.json`), the background service worker (`importScripts`), and Node (`require`, from `scripts/build-snapshot.js`). `lib/criterion.js` holds the All Films filter rules. So:
- They share globals in the browser and end with a `if (typeof module !== "undefined") module.exports = …` block for Node. Add any new export needed by the build script there.
- No DOM APIs in them. The service worker and Node have no `DOMParser`, which is why HTML parsing uses regexes and JSON-LD, and why `lib/site.js` holds selectors as plain strings.
- `lib/shared.js` (cache, `limiter`, `politeFetch`, `DAY_MS`) uses `chrome.*` and is **browser-only**. Node code must not depend on it.
- Script order matters: `manifest.json` content_scripts and the `importScripts` call in `background.js` load `shared.js` first, because the others use `DAY_MS` and similar globals at load time.

### Data flow
1. **Nightly snapshot** (`.github/workflows/snapshot.yml` → `scripts/build-snapshot.js`): reads the full catalog from the All Films page's JSON API (`allFilmsUrl`, id/title/year only), fetches directors from `/api/media/<id>` for films the previous snapshot doesn't already know, resolves each film on Letterboxd, and publishes `snapshot.json` to GitHub Pages (`SNAPSHOT_URL` in `lib/snapshot.js`), keyed by Criterion media id. It reuses the previous snapshot's directors and Letterboxd URLs (matched by id, or by `lbKey` for entries from before the redesign, when the snapshot was keyed by page slug), and refuses to publish if the catalog has fewer than 500 films or more than 10% of lookups fail. `ONLY=` takes media ids or titles as slugs. Films that `resolveFilm` can't match fall through to `scripts/wikidata.js` (below).
2. **Background worker** (`background.js`): syncs the snapshot hourly via alarm (at most every 6h, `no-cache` for ETag revalidation). It answers `{type: "lookup", film}` messages, checking the snapshot first and then running a live `resolveFilm` for snapshot misses, with per-film cache TTLs and in-flight dedup. Snapshot misses need live lookup because Letterboxd's search fallback needs the user's cookies (Cloudflare blocks it for the Action).
3. **User sync** (`lib/user.js`, `syncUser` in `background.js`): the popup (`popup.html`) stores a username under `user:name` and asks the worker to sync. The worker walks the user's public `/<user>/films/` and `/<user>/watchlist/` poster grids into `user` = `{username, watched: {lbSlug: rating|0}, watchlist: {lbSlug: 1}}`. These pages need no login, so no cookies are involved. The data is re-read every 3h on the hourly alarm, and `user:status` records the last outcome for the popup. Cards match on the Letterboxd slug in a result's `url` (`userMark`).
4. **Content script** (`content.js`): finds cards with a MutationObserver and IntersectionObserver. Every card links to `/films/<id>/…` or `/series/<id>/…`, and the id is the key. A card's printed title and year are enough for the cache key (`lbKey` ignores directors), so a known film paints with no request at all; otherwise Criterion metadata comes from the snapshot by id, or from `/api/media/<id>` (cached as `cc5:<id>`). The Letterboxd result usually comes from its own copy of the snapshot; only a miss or a stale entry is messaged to the background (`lookup` in `content.js`), because waking a sleeping MV3 worker costs more than the round trip does.

### Caching
- `chrome.storage.local` is mirrored into memory (`cacheMem` in `lib/shared.js`) in every context, kept in sync via `storage.onChanged`, so first paint is synchronous (`cachePeek`).
- The mirror loads in two passes, because reading the whole store costs a visible pause — the snapshot alone is 600KB+ and the per-film `lb:`/`cc5:` entries grow without bound. `cacheReady` is the handful of `HOT_KEYS` first paint needs; `cacheFull` is the rest, read behind it. `cacheGet` awaits `cacheFull`, so an await-ing caller never reads a not-yet-loaded key as a miss; `cachePeek` may miss one during the backfill and simply takes a slower path to the same answer. `cacheOwn` keeps the backfill from overwriting anything written or changed since the read started. `HOT_KEYS` repeats key names that `lib/snapshot.js`, `lib/user.js` and `content.js` define, because `shared.js` loads first — add a key there if first paint starts needing it.
- The content script runs at `document_start` so that read is in flight while the page parses. Badges wait on `cacheReady` and on the page being hydrated (below).
- `scanCards` badges a known card in the scan itself, which is what makes a rail's cards, or a page of All Films, appear at once. The rest wait for the IntersectionObserver (300px `rootMargin`), since each may cost an API request.
- Storage changes are coalesced into one `requestAnimationFrame` (`queueFlush`), since results land in bursts — the worker resolving every snapshot miss on the page. A new snapshot or user sync repaints in a single pass over `[data-ebert-key]` rather than a query per film.
- Entries are `{v, exp}`. Expired entries are returned flagged `stale`, so the old value is shown while a refresh runs. `v: null` caches a miss.
- Key prefixes: `lb:<squashed title>|<year>` for Letterboxd results. `lbKey` is shared so every context computes the same key, and the snapshot is indexed by it too. `cc5:<media id>` holds Criterion metadata from the API; bump the version number to invalidate. `catalog:filters` holds the All Films filters. `snapshot` holds the shared snapshot and `snapshot:checked` throttles syncing.
- `onInstalled` clears cached misses so an improved matcher can retry them, plus keys this version no longer reads (`cc4:` page-path metadata from before the redesign).
- The content script repaints cards when `lb:*` or `snapshot` keys change, and repaints every badge when `user` or `user:name` changes. It ignores `user` data synced for a different username than `user:name`.

### Hydration and client-side navigation
The site is server-rendered, then hydrated by React. Any node we add to server-rendered markup before hydration is a mismatch (React error #418), and React throws that markup away and renders it again. So `content.js` draws nothing until `SELECTORS.hydrated` (`next-route-announcer`, which Next.js's app router adds from an effect) exists, with a 5s timeout in case it ever goes away. That costs ~60ms of first paint.

Navigation is client-side, so a page can change without a load, and React reuses elements across renders. On every DOM change `scanCards` re-checks each card against the film id it was scanned for (`seenCards`) and repaints a card whose badge was re-rendered away. `syncDetail` drops the detail line when the path changes, redraws it if the hero was replaced, and looks each film page up once per visit.

### All Films filters
All Films (`/all-films`) gets a "Letterboxd" group at the top of its filter panel (first under the "Filters" label, ahead of Genres): a minimum rating, a runtime range, and the user's watched/watchlist state — what Letterboxd knows and the site's own filters can't ask. The rules are pure functions in `lib/criterion.js` (`matchesFilters`, `normalizeFilters`, `inRuntimeRange`, `RUNTIME_MIN`/`RUNTIME_MAX`/`RUNTIME_STEP`), which is where tests for them go; the controls and results are in `content.js` (`syncAllFilms`, `applyFilters`, `buildPanel`).
- **Results replace the site's grid while a filter is on.** The page loads its grid 60 at a time as you scroll, so hiding cards that fail would leave a strict filter with a near-empty page — and the site's loader doesn't fire again for a sentinel already in view. Instead the site's grid and loader get `.ebert-hidden`, and ours goes after them: the whole list comes from `allFilmsUrl(key, location.search)`, the same API the page uses with the page's own query string, so the site's genres/decades/countries/directors and sort still apply (they navigate client-side and change the query; `syncAllFilms` notices and re-reads). Films that pass are drawn 60 at a time, more as the end comes near.
- **Our cards are copies of the site's.** `captureTemplate` takes a clean copy of the first site card it sees (our badge and data attributes stripped, the "more" button and progress bar removed since they need the site's handlers, lazy-loading swapped for `loading="lazy"`), and `cardFor` fills it per film: `filmHref`, title, year, `formatRuntime`, `posterUrl`. To the rest of the script they're ordinary cards, so they get badges the usual way. Each film's copy is kept, so a filter change moves cards rather than rebuilding them.
- **The panel is a copy of the site's accordion**, taken from one that's open (a closed accordion doesn't render its body). It toggles the site's own state classes, derived from its classes by `stateClass` (`STATE_CLASSES` in `lib/site.js`), and swaps copies of the site's open and closed icons, since the site draws a different icon per state. The Watched choices are copies of the site's option pills.
- Rating and the watched state come from the Letterboxd result (snapshot or `lb:` cache); runtime is Criterion's own, from the list (`parseAllFilms`). A film missing the fact a filter asks about fails it, so an active filter never shows an unknown.
- Filters persist under `catalog:filters`. A status line above the results carries the count and a Clear whenever a filter is on, and a combination matching nothing gets an explicit empty state.
- There's no sort by Letterboxd rating yet; with the whole list in hand it would be `sortByRating` over `catalogFilms` in `applyFilters`, plus an option in the site's Sort group.

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
