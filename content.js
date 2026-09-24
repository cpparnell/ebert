// Year and director never change, so a hit is kept for good; a miss is retried daily.
const CRITERION_TTL = 3650 * DAY_MS;
const CRITERION_MISS_TTL = DAY_MS;
const MAX_ATTEMPTS = 4;
const criterionLimit = limiter(4);
const seenCards = new WeakSet();
const nearCards = new WeakSet(); // within rootMargin of the viewport right now
const busyCards = new WeakSet(); // queued or in flight

class TransientError extends Error {}

// The h1 is the clean title; og:title on collection pages carries " - <Collection> - The Criterion Channel".
function extractCriterionMeta(doc) {
  const title =
    doc.querySelector("h1.video-title, h1.collection-title")?.textContent.trim() ||
    doc.querySelector('meta[property="og:title"]')?.content?.split(" - ")[0].trim();
  // Only the page's own description: the body also holds credits of other films (a collection's
  // episode list), which would pin a collection or teaser to the wrong film.
  // Credit line is "Directed by X • 1994 • Country", but some pages put the country before the year.
  const description = doc
    .querySelector('meta[name="description"]')
    ?.content.replace(/&nbsp;|\u00a0/g, " ");
  const line = description?.match(/Directed by\s+([^\n]+)/)?.[1];
  if (!title || !line) return null;
  const [director, ...rest] = line.split("•").map((s) => s.trim());
  const year = rest.map((s) => s.match(/^\d{4}$/)?.[0]).find(Boolean);
  if (!director || !year) return null;
  return {
    title,
    year: +year,
    directors: director.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean),
  };
}

function ccKey(href) {
  const url = new URL(href, location.href);
  return url.origin === location.origin ? `cc4:${url.pathname}` : null;
}

// A film already known from its page or the shared snapshot, without any network.
function cachedMeta(href) {
  const key = ccKey(href);
  if (!key) return null;
  return cachePeek(key)?.v || cachePeek(SNAPSHOT_KEY)?.v?.films?.[criterionSlug(href)] || null;
}

// Snapshot first (refreshed nightly for everyone), then this install's own live lookups.
function cachedFilm(key) {
  const shared = snapshotByKey(cachePeek(SNAPSHOT_KEY)?.v).get(key);
  return shared ? { v: shared, stale: false } : cachePeek(key);
}

async function criterionMetaFor(href, wanted) {
  const key = ccKey(href);
  if (!key) return null;
  const cached = await cacheGet(key);
  const known = cachedMeta(href);
  if (known) return known;
  if (cached && !cached.stale) return cached.v;

  const res = await politeFetch(criterionLimit, href, { credentials: "include" }, wanted);
  if (!res.ok) throw new TransientError(`criterion-http-${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const meta = extractCriterionMeta(doc);
  await cacheSet(key, meta, meta ? CRITERION_TTL : CRITERION_MISS_TTL);
  return meta;
}

// films.criterionchannel.com lists the whole catalog as a table whose rows carry title, director
// and year inline, so its "cards" need no page fetch; everywhere else cards are www browse cards.
const ON_CATALOG = location.hostname === "films.criterionchannel.com";

const CARD_SELECTOR = ON_CATALOG
  ? "tr.criterion-channel__tr[data-role='grid-film']"
  : // Browse rows tag cards with item-type-*; collection pages (e.g. /southern-gothic) leave cards untyped.
    ".browse-item-card.item-type-movie, .browse-item-card.item-type-video, .browse-item-card:not([class*='item-type-'])";

// The film's link and the element the badge is drawn over, or null if the card lacks either.
function cardParts(card) {
  const link = ON_CATALOG
    ? card.querySelector(".criterion-channel__td--title a[href]")
    : card.querySelector(".browse-item-title a[href]");
  const container = ON_CATALOG
    ? card.querySelector(".criterion-channel__film-img-wrap")
    : card.querySelector(".browse-image-container");
  return link && container ? { href: link.href, container } : null;
}

// Same rules as parseCatalog, so the key matches the snapshot's entry for this film.
function catalogRowMeta(row) {
  // textContent decodes entities once; some cells are double-escaped ("Ken&amp;#039;ichi").
  const cell = (name) =>
    decodeEntities(row.querySelector(`.criterion-channel__td--${name}`)?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  const title = cell("title");
  const year = cell("year");
  if (!title || !/^(18|19|20)\d\d$/.test(year)) return null;
  return { title, year: +year, directors: splitDirectors(cell("director")) };
}

const knownMeta = (card, href) => (ON_CATALOG ? catalogRowMeta(card) : cachedMeta(href));
const metaFor = (card, href, wanted) =>
  ON_CATALOG ? Promise.resolve(catalogRowMeta(card)) : criterionMetaFor(href, wanted);

// The snapshot and this install's own results are mirrored here too, so a film already known needs
// no message at all. That matters more than one round trip: the MV3 worker sleeps after 30s idle,
// so the first card of a visit would otherwise pay its cold start. Stale entries still go through
// the worker, which serves the old value and refreshes behind it.
async function lookup(film) {
  const local = cachedFilm(lbKey(film));
  if (local && !local.stale) return local.v;
  const res = await chrome.runtime.sendMessage({ type: "lookup", film });
  if (!res || res.error) throw new TransientError(`letterboxd-error: ${res?.error}`);
  return res.film;
}

const formatCount = (n) => new Intl.NumberFormat().format(n);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(paths) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
}

const EYE =
  '<path d="M0.8 5C2 2.9 3.4 1.9 5 1.9S8 2.9 9.2 5C8 7.1 6.6 8.1 5 8.1S2 7.1 0.8 5Z" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
  '<circle cx="5" cy="5" r="1.5" fill="currentColor"/>';
const CLOCK =
  '<circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
  '<path d="M5 2.7V5l1.6 1.1" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>';

// Marks a rating that belongs to the whole series ("Carlos" for "Carlos: Part 2"): a stacked
// icon that widens to spell out "Series Rating" on hover.
function seriesTag() {
  const tag = el("span", "ebert-series");
  tag.append(
    icon(
      '<rect x="3" y="0.75" width="6.25" height="6.25" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
        '<rect x="0.75" y="3" width="6.25" height="6.25" rx="1" fill="currentColor"/>'
    ),
    el("span", "ebert-series-label", "Series Rating")
  );
  return tag;
}

// The user's own history with this film (see lib/user.js), or null if no username is set.
// Data synced for a previous username is ignored until the new one's sync lands.
function markFor(film) {
  const user = cachePeek(USER_KEY)?.v;
  return user?.username === cachePeek(USERNAME_KEY)?.v ? userMark(film, user) : null;
}

// The user's own score sits beside the consensus, in the same notation, since the whole point is
// reading one against the other. Half-stars are exact at one decimal place ("3.5", "4.0").
function markTag(mark) {
  const tag = el("span", mark.watched ? "ebert-mark ebert-mark--watched" : "ebert-mark ebert-mark--watchlist");
  tag.append(icon(mark.watched ? EYE : CLOCK));
  if (mark.rating) tag.append(el("span", "ebert-mark-rating", mark.rating.toFixed(1)));
  return tag;
}

const markTitle = (mark) =>
  mark.watched ? `You watched this${mark.rating ? ` · ${starText(mark.rating)}` : ""}` : "In your watchlist";

// Replaces any existing badge, so a score painted from a stale cache entry gets updated in place.
// Letterboxd withholds the average for films with few ratings; a dash tells that apart from a miss.
function renderBadge(container, film) {
  const badge = el("div", "ebert-badge");
  if (film.rating == null) {
    badge.classList.add("ebert-badge--unrated");
    badge.title = "Letterboxd: not enough ratings yet";
    badge.append(el("span", "ebert-star", "★"), el("span", null, "–"));
  } else {
    badge.title = `Letterboxd ${film.series ? "series rating " : ""}${film.rating.toFixed(2)} · ${formatCount(film.ratingCount)} ratings`;
    badge.append(el("span", "ebert-star", "★"), el("span", null, film.rating.toFixed(1)));
  }
  if (film.series) {
    badge.classList.add("ebert-badge--series");
    badge.append(seriesTag());
  }
  const mark = markFor(film);
  if (mark) {
    badge.append(markTag(mark));
    badge.title += ` · ${markTitle(mark)}`;
  }
  const existing = container.querySelector(".ebert-badge");
  if (existing) existing.replaceWith(badge);
  else container.appendChild(badge);
}

let detail = null; // { anchor, film }, kept so the line can be redrawn when the user's data syncs

function renderDetail(anchor, film) {
  detail = { anchor, film };
  const link = el("a", "ebert-detail");
  link.href = film.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  if (film.rating == null) {
    link.append(el("span", "ebert-label", "Letterboxd: not enough ratings yet"));
  } else {
    link.append(
      el("span", "ebert-star", "★"),
      el("span", "ebert-score", film.rating.toFixed(2)),
      ...(film.series ? [seriesTag()] : []),
      el("span", "ebert-label", "Letterboxd"),
      el("span", "ebert-muted", `${formatCount(film.ratingCount)} ratings`)
    );
  }
  const mark = markFor(film);
  if (mark) {
    const you = el("span", `ebert-you ${mark.watched ? "ebert-you--watched" : "ebert-you--watchlist"}`);
    you.append(icon(mark.watched ? EYE : CLOCK), el("span", null, mark.watched ? "Watched" : "In your watchlist"));
    if (mark.rating) you.append(el("span", "ebert-you-rating", starText(mark.rating)));
    link.append(you);
  }
  const existing = document.querySelector(".ebert-detail");
  if (existing) existing.replaceWith(link);
  else anchor.after(link);
}

async function handleDetailPage() {
  if (ON_CATALOG || document.body.classList.contains("browse")) return;
  const h1 = document.querySelector("h1.video-title, h1.collection-title");
  const meta = h1 && extractCriterionMeta(document);
  if (!meta) return;
  const film = await lookup({ ...meta, slug: criterionSlug(location.href) }).catch((err) => console.warn("[ebert]", err));
  if (!film) return;
  const badges = h1.parentElement.querySelector("h5.badges-container");
  renderDetail(badges || h1, film);
}

// Paints straight from the in-memory cache; returns true only if nothing needs refreshing.
function paintFromCache(card, { href, container }) {
  const meta = knownMeta(card, href);
  if (!meta) return false;
  card.dataset.ebertKey = lbKey(meta);
  const film = cachedFilm(lbKey(meta));
  if (!film?.v) return false;
  renderBadge(container, film.v);
  return !film.stale;
}

function repaint(key, film) {
  if (!film) return;
  for (const card of document.querySelectorAll(`[data-ebert-key="${CSS.escape(key)}"]`)) {
    const parts = cardParts(card);
    if (parts) renderBadge(parts.container, film);
  }
}

// Every badge already drawn, e.g. after the user's watched films sync.
function repaintAll() {
  for (const card of document.querySelectorAll("[data-ebert-key]")) {
    const parts = cardParts(card);
    const film = cachedFilm(card.dataset.ebertKey)?.v;
    if (parts && film && parts.container.querySelector(".ebert-badge")) renderBadge(parts.container, film);
  }
  if (detail) renderDetail(detail.anchor, detail.film);
}

// A stale score is shown first and refreshed in the background, and a new snapshot can land
// mid-visit (e.g. just after install); repaint the affected cards either way.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let refilter = false;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key.startsWith("lb:")) {
      repaint(key, newValue?.v);
      refilter = true;
    }
    if (key === SNAPSHOT_KEY) {
      for (const [k, film] of snapshotByKey(newValue?.v)) repaint(k, film);
      refilter = true;
    }
    if (key === USER_KEY || key === USERNAME_KEY) {
      repaintAll();
      refilter = true;
    }
    // Another Criterion tab changed the filters.
    if (key === FILTERS_KEY && JSON.stringify(newValue?.v) !== JSON.stringify(filters)) {
      filters = normalizeFilters(newValue?.v);
      syncFilterControls();
      refilter = true;
    }
  }
  // A rating or a mark arriving can move a row in or out of the current filter.
  if (refilter && ON_CATALOG) applyFilters();
});

function settle(card, state) {
  visibility.unobserve(card);
  nearCards.delete(card);
  card.dataset.ebert = state;
}

// data-ebert on each card records its outcome, for diagnosing misses from DevTools.
async function processCard(card) {
  const parts = cardParts(card);
  if (!parts) return settle(card, "no-link-or-image");
  const { href, container } = parts;
  busyCards.add(card);
  card.dataset.ebert = "pending";
  const wanted = () => nearCards.has(card);
  try {
    const meta = await metaFor(card, href, wanted);
    if (!meta) return settle(card, "no-criterion-meta");
    card.dataset.ebertQuery = `${meta.title} | ${meta.year} | ${meta.directors.join(", ")}`;
    card.dataset.ebertKey = lbKey(meta);
    if (!wanted()) throw new Cancelled();
    const film = await lookup({ ...meta, slug: criterionSlug(href) });
    if (!film) return settle(card, "no-letterboxd-match");
    renderBadge(container, film);
    settle(card, film.rating == null ? "no-rating" : "ok");
  } catch (err) {
    // The extension was reloaded under this page; this script is orphaned until the tab is refreshed.
    if (!chrome.runtime?.id) {
      visibility.disconnect();
      delete card.dataset.ebert;
      return;
    }
    // Scrolled away before its turn; still observed, so it resumes when it comes back into view.
    if (err instanceof Cancelled) return (card.dataset.ebert = "deferred");
    const attempts = (+card.dataset.ebertAttempts || 0) + 1;
    card.dataset.ebertAttempts = attempts;
    settle(card, err instanceof TransientError ? err.message : `error: ${err}`);
    console.warn("[ebert]", href, err);
    if (err instanceof TransientError && attempts < MAX_ATTEMPTS) {
      setTimeout(() => visibility.observe(card), 2000 * 2 ** attempts);
    }
  } finally {
    busyCards.delete(card);
  }
}

// Cards stay observed until settled, so leaving and re-entering the viewport is tracked.
const visibility = new IntersectionObserver(
  (entries) => {
    for (const { target: card, isIntersecting } of entries) {
      if (!isIntersecting) {
        nearCards.delete(card);
        continue;
      }
      nearCards.add(card);
      if (!busyCards.has(card)) processCard(card);
    }
  },
  { rootMargin: "300px" }
);

function scanCards() {
  for (const card of document.querySelectorAll(CARD_SELECTOR)) {
    if (seenCards.has(card)) continue;
    seenCards.add(card);
    const parts = cardParts(card);
    if (parts && paintFromCache(card, parts)) {
      card.dataset.ebert = "ok";
      continue;
    }
    visibility.observe(card);
  }
}

let scanQueued = false;

function start() {
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scanCards();
    });
  }).observe(document.body, { childList: true, subtree: true });
  scanCards();
}

// ---------- Catalog filters ----------
// The catalog ships every row in one page, so filtering is a class on rows, not a round trip.
// The controls live inside the site's own Advanced Filters panel, as one more group beside
// Genres/Decades/Countries/Directors, and ask only what Letterboxd knows and that panel can't:
// rating, runtime, and the user's own history.
//
// Nothing here reaches the site's filter logic. StoreFilters captures its checkboxes once at
// init (`.filter-group-option input[type=checkbox]`) and only those feed the query string its
// Apply button navigates to, so ours are injected later and deliberately not given that class.
// Apply still works: it reloads with the site's filters, and ours come back from storage.
const FILTERS_KEY = "catalog:filters";
const FILTERS_TTL = 3650 * DAY_MS;

let filters = DEFAULT_FILTERS;
// Both replaced by setupFilters. applyFilters runs again whenever ratings or the user's marks land.
let applyFilters = () => {};
let syncFilterControls = () => {};

const rowFacts = new WeakMap();

// A row's Letterboxd cache key, fixed for the life of the page unlike the rating behind it.
function rowKey(row) {
  if (!rowFacts.has(row)) {
    const meta = catalogRowMeta(row);
    rowFacts.set(row, meta ? lbKey(meta) : null);
  }
  return rowFacts.get(row);
}

// Everything the filters ask about. A row with no Letterboxd match keeps null values, so an
// active rating or runtime filter hides it rather than showing an unknown.
function rowFilm(row) {
  const key = rowKey(row);
  const lb = key ? cachedFilm(key)?.v : null;
  return { rating: lb?.rating ?? null, runtime: lb?.runtime ?? null, mark: lb ? markFor(lb) : null };
}

const catalogRows = () => [...document.querySelectorAll(CARD_SELECTOR)];

function button(className, text) {
  const node = el("button", className, text);
  node.type = "button";
  return node;
}

// One option in the panel, borrowing the site's own markup: it hides the checkbox and draws the
// dot as the label's ::before, so these look like the Genres and Decades beside them. The class
// is ours (`ebert-option`) rather than the site's `filter-group-option`, which its own JS reads.
let optionId = 0;

function panelOption(label, checked, onToggle) {
  const item = el("li", "ebert-option");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = `ebert-option-${++optionId}`;
  box.checked = checked;
  box.addEventListener("change", () => onToggle(box.checked));
  const text = el("label", "criterion-channel__filter-label", label);
  text.htmlFor = box.id;
  item.append(box, text);
  return { item, box };
}

// A list of options where at most one is on, so clicking the checked one turns it off. `value`
// is null for "no filter", which is what the site's Reset and our Clear return them to.
function panelChoices(options, valueFor, onChange) {
  const list = el("ul", "ebert-options");
  const boxes = options.map(({ value, label }) => {
    const { item, box } = panelOption(label, valueFor() === value, (on) => onChange(on ? value : null));
    list.append(item);
    return { value, box };
  });
  const sync = () => {
    for (const { value, box } of boxes) box.checked = valueFor() === value;
  };
  return { list, sync };
}

function panelGroup(title) {
  const group = el("div", "filter-group ebert-filter-group");
  const head = el("div", "filter-group-head");
  head.append(el("h3", "criterion-channel__filter-group-label", title));
  const body = el("div", "ebert-filter-body");
  group.append(head, body);
  return { group, body };
}

function panelSection(title) {
  const section = el("div", "ebert-section");
  section.append(el("h4", "ebert-section-title", title));
  return section;
}

// Reads the pair back the way the ends are meant: a handle on an end is no bound there.
function runtimeLabel({ runtimeMin, runtimeMax }) {
  const floor = runtimeMin > RUNTIME_MIN;
  const ceiling = runtimeMax < RUNTIME_MAX;
  if (!floor && !ceiling) return null; // the whole track: no filter at all
  if (floor && ceiling) return runtimeMin === runtimeMax ? `${runtimeMin} min` : `${runtimeMin} to ${runtimeMax} min`;
  return floor ? `${runtimeMin} min and over` : `${runtimeMax} min and under`;
}

// Runtime is a range, and HTML has no two-handle slider. Two range inputs are stacked on one
// track instead, each drawing only its thumb (the CSS hides their own tracks and paints ours), so
// both keep native focus and arrow keys — which a div-and-pointer-events widget would give up.
// Each handle pushes the other rather than stopping against it, so neither can be crossed.
function rangeSlider(read, commit) {
  const rangeInput = (which, label) => {
    const input = document.createElement("input");
    input.type = "range";
    input.className = `ebert-range-input ebert-range-input--${which}`;
    input.min = RUNTIME_MIN;
    input.max = RUNTIME_MAX;
    input.step = RUNTIME_STEP;
    input.setAttribute("aria-label", label);
    return input;
  };
  const lo = rangeInput("lo", "Shortest runtime, in minutes");
  const hi = rangeInput("hi", "Longest runtime, in minutes");
  const fill = el("div", "ebert-range-fill");
  const track = el("div", "ebert-range");
  track.append(fill, lo, hi);
  const value = el("span", "ebert-slider-value");
  const row = el("div", "ebert-slider-row");
  row.append(track, value);

  // Both ends of the fill land on a knob's centre, and a knob sits half its own width inside the
  // rail, so the offsets are measured the way the native track measures them.
  const frac = (n) => (n - RUNTIME_MIN) / (RUNTIME_MAX - RUNTIME_MIN);
  const atKnob = (f) => `calc(8px + ${f} * (100% - 16px))`;
  const sync = () => {
    const f = read();
    lo.value = f.runtimeMin;
    hi.value = f.runtimeMax;
    fill.style.left = atKnob(frac(f.runtimeMin));
    fill.style.right = atKnob(1 - frac(f.runtimeMax));
    // With both handles on the same end only one can be on top, and it has to be the one that can
    // still move: at the far end that's the low handle, everywhere else the high one.
    lo.classList.toggle("ebert-range-input--front", f.runtimeMin > (RUNTIME_MIN + RUNTIME_MAX) / 2);
    const label = runtimeLabel(f);
    value.replaceChildren(label ? el("span", null, label) : el("span", "ebert-any", "Any length"));
  };

  lo.addEventListener("input", () => {
    const v = +lo.value;
    commit({ runtimeMin: v, runtimeMax: Math.max(v, read().runtimeMax) });
    sync();
  });
  hi.addEventListener("input", () => {
    const v = +hi.value;
    commit({ runtimeMax: v, runtimeMin: Math.min(v, read().runtimeMin) });
    sync();
  });

  return { row, sync };
}

function setupFilters() {
  const table = document.querySelector(".criterion-channel__gridview");
  const host = table?.closest(".max-width-container");
  const panel = document.querySelector("[data-store-filters] .filter-options-container");
  if (!host || !panel) return;
  filters = normalizeFilters(cachePeek(FILTERS_KEY)?.v);

  const commit = (patch) => {
    filters = normalizeFilters({ ...filters, ...patch });
    applyFilters();
    cacheSet(FILTERS_KEY, filters, FILTERS_TTL).catch(() => {});
  };

  const { group, body } = panelGroup("Letterboxd");

  // Rating, as a slider: the useful range is narrow (most of the catalog sits between 3 and 4),
  // so tenths are what separate "good" from "great" here, and a list of bands would be too coarse.
  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "ebert-slider";
  slider.min = 0;
  slider.max = MAX_MIN_RATING;
  slider.step = 0.1;
  slider.setAttribute("aria-label", "Minimum Letterboxd rating");
  const sliderValue = el("span", "ebert-slider-value");
  const syncSlider = () => {
    slider.value = filters.minRating;
    slider.style.setProperty("--ebert-fill", filters.minRating / MAX_MIN_RATING);
    sliderValue.replaceChildren(
      ...(filters.minRating
        ? [el("span", "ebert-star", "★"), el("span", null, `${filters.minRating.toFixed(1)} and up`)]
        : [el("span", "ebert-any", "Any rating")])
    );
  };
  slider.addEventListener("input", () => {
    commit({ minRating: +slider.value });
    syncSlider();
  });
  const rating = panelSection("Rating");
  const ratingRow = el("div", "ebert-slider-row");
  ratingRow.append(slider, sliderValue);
  rating.append(ratingRow);
  body.append(rating);

  // Runtime needs a snapshot built since runtimes were added; until then there's nothing to ask.
  const hasRuntime = catalogRows().some((row) => rowFilm(row).runtime);
  const runtime = hasRuntime ? rangeSlider(() => filters, commit) : null;
  if (runtime) {
    const section = panelSection("Runtime");
    section.append(runtime.row);
    body.append(section);
  }

  // "Everything" is the absence of this filter, so it isn't offered as an option to tick.
  const seen = panelChoices(
    SEEN_OPTIONS.filter((o) => o.value !== "all"),
    () => filters.seen,
    (value) => commit({ seen: value || "all" })
  );
  const seenSection = panelSection("Watched");
  const seenHint = el("p", "ebert-hint", "Add your Letterboxd username in the Ebert popup.");
  seenSection.append(seen.list, seenHint);
  body.append(seenSection);

  panel.append(group);
  addPanelMenuItem(group);

  // The panel is a modal over the table, so the result of a filter is only visible once it's
  // closed. This line stands in for that: it appears only while a filter is on, and carries the
  // count and the way out, so a filter kept from an earlier visit can't silently empty the page.
  const status = el("div", "ebert-status");
  const count = el("span", "ebert-status-count");
  const clear = button("ebert-link", "Clear");
  status.append(el("span", "ebert-status-label", "Letterboxd filters"), count, clear);

  const empty = el("div", "ebert-empty");
  const clearEmpty = button("ebert-link", "Clear filters");
  empty.append(el("span", null, "No films match these filters."), clearEmpty);
  empty.hidden = true;

  const clearAll = () => {
    commit(DEFAULT_FILTERS);
    syncControls();
  };
  clear.addEventListener("click", clearAll);
  clearEmpty.addEventListener("click", clearAll);
  // The site's own Reset clears its checkboxes; ours are in the same panel, so it clears them too.
  document.querySelector("[data-store-filters] [data-is-reset-button]")?.addEventListener("click", clearAll);

  host.prepend(status, empty);

  const syncControls = () => {
    // Nothing to compare against until a username is set in the popup; a "watched" filter left
    // over from before it was cleared would hide rows with no visible way to bring them back.
    const named = !!cachePeek(USERNAME_KEY)?.v;
    if (!named && filters.seen !== "all") commit({ seen: "all" });
    seenSection.classList.toggle("ebert-section--off", !named);
    seenHint.hidden = named;
    syncSlider();
    runtime?.sync();
    seen.sync();
  };

  applyFilters = () => {
    const rows = catalogRows();
    let shown = 0;
    for (const row of rows) {
      const pass = matchesFilters(rowFilm(row), filters);
      row.classList.toggle("ebert-hidden", !pass);
      if (pass) shown++;
    }
    count.textContent = `${formatCount(shown)} of ${formatCount(rows.length)} films`;
    status.hidden = isDefaultFilters(filters);
    empty.hidden = shown > 0 || !rows.length || isDefaultFilters(filters);
  };

  syncFilterControls = syncControls;
  syncControls();
  applyFilters();
}

// The panel's left-hand nav. The site binds its own items at init, so this one scrolls the group
// into view itself — and without touching location.hash, which carries the Letterboxd sort.
function addPanelMenuItem(group) {
  const titles = document.querySelector("[data-store-filters] .filter-titles");
  if (!titles) return;
  const item = el("li", "filter-title criterion-channel__filter-title ebert-filter-title");
  const link = el("a", null, "Letterboxd");
  link.href = "#";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    group.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  item.append(link);
  titles.append(item);
}

// films.criterionchannel.com sorts on the server (?sort=, which answers 500 to values it doesn't
// know), so sorting by Letterboxd rating reorders the rows in place and is kept in the hash:
// #letterboxd (best first) or #letterboxd-asc.
function ratingSortDir() {
  const m = location.hash.match(/^#letterboxd(-asc)?$/);
  return m ? (m[1] ? "asc" : "desc") : null;
}

function setupRatingSort() {
  const select = document.querySelector("select[data-store-sorting]");
  const tbody = document.querySelector(".criterion-channel__tbody");
  if (!select || !tbody) return;
  const direction = document.querySelector("button[data-store-direction]");
  select.add(new Option("Letterboxd Rating", "letterboxd"));

  const apply = (dir) => {
    history.replaceState(null, "", `${location.pathname}${location.search}#letterboxd${dir === "asc" ? "-asc" : ""}`);
    select.value = "letterboxd";
    // The site's button holds the direction its next click switches to.
    direction?.setAttribute("data-store-direction", dir === "asc" ? "desc" : "asc");
    const ratingOf = (row) => {
      const meta = catalogRowMeta(row);
      return meta && cachedFilm(lbKey(meta))?.v?.rating;
    };
    tbody.append(...sortByRating([...tbody.querySelectorAll(CARD_SELECTOR)], ratingOf, dir));
  };

  // Capture phase, ahead of the site's own handlers, which navigate to a new ?sort= or ?direction=.
  document.addEventListener(
    "change",
    (e) => {
      if (e.target !== select) return;
      if (select.value === "letterboxd") {
        e.stopImmediatePropagation();
        apply("desc");
      } else if (ratingSortDir()) {
        // The site builds its URL by appending to location.href; a hash would swallow the query.
        history.replaceState(null, "", location.pathname + location.search);
      }
    },
    true
  );
  direction?.addEventListener(
    "click",
    (e) => {
      const dir = ratingSortDir();
      if (!dir) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      apply(dir === "asc" ? "desc" : "asc");
    },
    true
  );
  const dir = ratingSortDir();
  if (dir) apply(dir);
}

// This script runs at document_start, so the cache read above is already in flight while the page
// is still parsing. Painting needs both it and the DOM: the mirror so the first scan can badge every
// known card at once, and the markup the cards live in. Cards added later are caught by the observer.
const domReady =
  document.readyState === "loading"
    ? new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }))
    : Promise.resolve();

const painting = Promise.all([
  cacheReady.catch((err) => console.warn("[ebert] cache load failed", err)),
  domReady,
]).then(() => {
  start();
  handleDetailPage();
});

// The catalog's sort menu and Advanced Filters panel are built by the site's own scripts, and both
// bind their handlers at init; ours have to go in after that, so they wait for load rather than
// DOMContentLoaded. Badges don't — they're already going up by then.
if (ON_CATALOG) {
  const loaded =
    document.readyState === "complete"
      ? Promise.resolve()
      : new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
  Promise.all([painting, loaded]).then(() => {
    setupFilters();
    setupRatingSort();
  });
}

// Pick up films logged or watchlisted since the last visit; marks repaint when the sync lands.
chrome.runtime.sendMessage({ type: "syncUser", maxAge: USER_REFRESH_MS }).catch(() => {});
