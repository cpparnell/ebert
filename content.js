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

async function lookup(film) {
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

// Replaces any existing badge, so a score painted from a stale cache entry gets updated in place.
function renderBadge(container, film) {
  const badge = el("div", "ebert-badge");
  badge.title = `Letterboxd ${film.rating.toFixed(2)} · ${formatCount(film.ratingCount)} ratings`;
  badge.append(el("span", "ebert-star", "★"), el("span", null, film.rating.toFixed(1)));
  const existing = container.querySelector(".ebert-badge");
  if (existing) existing.replaceWith(badge);
  else container.appendChild(badge);
}

function renderDetail(anchor, film) {
  if (document.querySelector(".ebert-detail")) return;
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
      el("span", "ebert-label", "Letterboxd"),
      el("span", "ebert-muted", `${formatCount(film.ratingCount)} ratings`)
    );
  }
  anchor.after(link);
}

async function handleDetailPage() {
  if (document.body.classList.contains("browse")) return;
  const h1 = document.querySelector("h1.video-title, h1.collection-title");
  const meta = h1 && extractCriterionMeta(document);
  if (!meta) return;
  const film = await lookup(meta).catch((err) => console.warn("[ebert]", err));
  if (!film) return;
  const badges = h1.parentElement.querySelector("h5.badges-container");
  renderDetail(badges || h1, film);
}

// Paints straight from the in-memory cache; returns true only if nothing needs refreshing.
function paintFromCache(card, link, container) {
  const meta = cachedMeta(link.href);
  if (!meta) return false;
  card.dataset.ebertKey = lbKey(meta);
  const film = cachedFilm(lbKey(meta));
  if (!film?.v || film.v.rating == null) return false;
  renderBadge(container, film.v);
  return !film.stale;
}

function repaint(key, film) {
  if (film?.rating == null) return;
  for (const card of document.querySelectorAll(`[data-ebert-key="${CSS.escape(key)}"]`)) {
    const container = card.querySelector(".browse-image-container");
    if (container) renderBadge(container, film);
  }
}

// A stale score is shown first and refreshed in the background, and a new snapshot can land
// mid-visit (e.g. just after install); repaint the affected cards either way.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key.startsWith("lb:")) repaint(key, newValue?.v);
    if (key === SNAPSHOT_KEY) {
      for (const [k, film] of snapshotByKey(newValue?.v)) repaint(k, film);
    }
  }
});

function settle(card, state) {
  visibility.unobserve(card);
  nearCards.delete(card);
  card.dataset.ebert = state;
}

// data-ebert on each card records its outcome, for diagnosing misses from DevTools.
async function processCard(card) {
  const link = card.querySelector(".browse-item-title a[href]");
  const container = card.querySelector(".browse-image-container");
  if (!link || !container) return settle(card, "no-link-or-image");
  busyCards.add(card);
  card.dataset.ebert = "pending";
  const wanted = () => nearCards.has(card);
  try {
    const meta = await criterionMetaFor(link.href, wanted);
    if (!meta) return settle(card, "no-criterion-meta");
    card.dataset.ebertQuery = `${meta.title} | ${meta.year} | ${meta.directors.join(", ")}`;
    card.dataset.ebertKey = lbKey(meta);
    if (!wanted()) throw new Cancelled();
    const film = await lookup(meta);
    if (!film) return settle(card, "no-letterboxd-match");
    if (film.rating == null) return settle(card, "no-rating");
    renderBadge(container, film);
    settle(card, "ok");
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
    console.warn("[ebert]", link.href, err);
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

// Browse rows tag cards with item-type-*; collection pages (e.g. /southern-gothic) leave cards untyped.
function scanCards() {
  for (const card of document.querySelectorAll(
    ".browse-item-card.item-type-movie, .browse-item-card.item-type-video, .browse-item-card:not([class*='item-type-'])"
  )) {
    if (seenCards.has(card)) continue;
    seenCards.add(card);
    const link = card.querySelector(".browse-item-title a[href]");
    const container = card.querySelector(".browse-image-container");
    if (link && container && paintFromCache(card, link, container)) {
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

// Wait for the cache mirror so the first scan can paint every cached card at once.
cacheReady.catch((err) => console.warn("[ebert] cache load failed", err)).then(start);
handleDetailPage();
