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
`lib/letterboxd.js`, `lib/criterion.js`, `lib/snapshot.js`, and `lib/user.js` run in three places: the content script (listed in `manifest.json`), the background service worker (`importScripts`), and Node (`require`, from `scripts/build-snapshot.js`). `lib/taste.js` runs in two of them — the content script and Node — since nothing in the worker predicts. So:
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

### Taste model (`lib/taste.js`)
Predicts what the user would rate a film. **No training, no model file, no server**: it's a set of shrunk averages rebuilt in milliseconds from `user` and the snapshot. Pure functions, so `tests/taste.test.js` covers all of it. Nothing paints it yet — the algorithm and its evaluation harness are complete, the UI isn't wired.

- **It models the residual** (their rating − Letterboxd's consensus), never the rating. Consensus already encodes "is this film good"; the residual is the only part that's about this viewer. Modelling raw ratings would just re-derive what Letterboxd already told us.
- Two levels. A **global offset** (they rate +0.3 against the crowd), applied to everything — which means it reorders nothing, and exists only so a displayed number sits on their scale. Then **per-feature offsets** for director, genre, decade and country, computed on residuals *net of* that global offset, so each measures "compared to how they usually differ". Only these discriminate between films, so only these recommend.
- Centring on the global offset (rather than on zero) is what makes shrinkage correct: a sparse director shrinks toward *their own average*, not toward the crowd's. Shrinking raw residuals would drag every thin feature back to consensus and quietly cancel the global term.
- `SHRINK_K = 4` — half weight at n=4. This is what stops one well-liked Hungarian film becoming "you love Hungarian cinema".
- Weights (`TASTE_FEATURES`) sum to 0.9, not 1, and are **not renormalized** over the features a film happens to have. The four signals are correlated — a Bresson film is also French, also a drama — so this is a weighted average of overlapping estimators, and under-applying is the right guard against triple-counting one fact. A film missing a feature therefore falls back toward consensus rather than amplifying the features it does have.
- **It declines.** `buildTasteModel` returns null below `TASTE_MIN_RATINGS` (30 usable rated films); `predictRating` returns null when a film's features clear less than `TASTE_MIN_EVIDENCE`, i.e. when only the global offset would carry it, which is no information at all. A missing prediction costs far less trust than a confident wrong one.
- Training samples exclude: films logged without a rating (no signal), consensus under `TASTE_MIN_RATING_COUNT` raters (too noisy a baseline to subtract), and **series installments** — their Letterboxd rating is the whole work's while the user's rating is the episode's, so the difference measures nothing.
- `evaluateTaste` is leave-one-out over the user's own history, the only honest test available since there's no held-out set. It scores against two baselines: raw consensus, and consensus shifted by the global offset. Beating the first is easy and means little; **`centeredMae` is the one that matters**, because it asks whether the feature terms know anything beyond "this user rates high". If the model doesn't beat that on real data, ship consensus and delete the rest.
- `recommendFilms` is ranking, not prediction: it drops watched films and caps one film per director, because sorting by score alone returns five films by the same director.

**Measured, 2026-09-23 — it does not work, and nothing should paint it.** Evaluated against a real profile (342 rated films, all resolved on Letterboxd, leave-one-out):

| | MAE |
|---|---|
| raw consensus | 0.468 |
| consensus + global offset | 0.467 |
| full model | 0.466 |

A 0.4% improvement on a scale displayed to 0.1 stars — immaterial. Out-of-fold, the features' claimed deviation correlates with the actual one at **r = 0.13 (R² 1.7%)**, and the model's predictions span ±0.043 stars against an actual residual spread of ±0.583: it predicts a near-constant, correctly, because it has almost nothing to go on. On the 51-film Criterion-only subset it looked better (2% lift) — a permutation test put that at **p = 0.21**, and feeding it 6.8× the data shrank the lift to 0.17%, which is what a true effect of zero looks like.

Two things worth keeping from the exercise:
- **Genre carries what little signal exists; director carries almost none** — the opposite of the weights above. Genre-only at full weight was the best of seven configurations (1.33% over consensus, itself optimistic since it was selected on the same leave-one-out data). Director is hopeless by construction: 225 of 279 values were singletons even across a full 342-film history, so shrinkage correctly discards it. The learned genre offsets are at least coherent (horror −0.27, documentary +0.16, comedy +0.12).
- **A taste model has to train on the user's whole Letterboxd history, not the catalog overlap.** Only 51 of those 342 ratings were Criterion films; the model doesn't need a film to be in the catalog to learn from it, only to have a consensus and features. Any retry has to fetch the full history — which means ~340 Letterboxd page fetches from the user's own browser, since Cloudflare 403s this from Node.

The honest reading is that how far someone lands from the crowd on a given film is mostly idiosyncratic, and director/genre/decade/country don't capture it. Ranking is more forgiving than prediction, but r = 0.13 doesn't reorder much either. **Ship consensus.** The code stays because it's tested, gated and inert, and `evaluateTaste` is the thing to re-run before anyone tries this again — but wiring it to a badge would be selling a number we've measured to be empty.
- Features come from `parseFilmPage`'s JSON-LD (`genre`, `countryOfOrigin`), so they cost no extra request; directors and year come from the Criterion catalog record, which is why `tasteFeatures` takes both objects. They add ~45 bytes/film uncompressed (~145KB over the catalog, ~35KB gzipped) — and `snapshot` is a `HOT_KEY`, so that lands on the first-paint read. If that read gets slow, taste features are the obvious thing to split into a lazily-fetched second file, since nothing about first paint needs them.

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
