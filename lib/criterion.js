// films.criterionchannel.com lists the whole catalog (title, director, country, year) on one public page.
const CATALOG_URL = "https://films.criterionchannel.com/";
const CATALOG_KEY = "catalog";

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

// Some catalog cells are double-escaped ("Ken&amp;#039;ichi"), hence two passes.
const cellText = (s) =>
  decodeEntities(decodeEntities(s.replace(/<[^>]*>/g, ""))).replace(/\s+/g, " ").trim();

const splitDirectors = (s) => s.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean);

// A film's collection page (/m-1) and its video page (/videos/m) can have different slugs,
// so this catches most cards, not all; the rest fall back to fetching the page.
function criterionSlug(href) {
  return new URL(href, "https://www.criterionchannel.com/").pathname.split("/").filter(Boolean).pop();
}

// Parsed with regexes rather than DOMParser, which the background service worker doesn't have.
// Returns { slug: { title, year, directors } }, skipping rows without a plausible year.
function parseCatalog(html) {
  const out = {};
  const rows = html.match(/<tr class="criterion-channel__tr"[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) {
    const href = row.match(/data-href="([^"]+)"/)?.[1];
    const cell = (name) => {
      const m = row.match(new RegExp(`criterion-channel__td--${name}">([\\s\\S]*?)</td>`));
      return m ? cellText(m[1]) : "";
    };
    const title = cell("title");
    const year = cell("year");
    if (!href || !title || !/^(18|19|20)\d\d$/.test(year)) continue;
    out[criterionSlug(href)] = { title, year: +year, directors: splitDirectors(cell("director")) };
  }
  return out;
}

// Orders catalog rows by Letterboxd rating. Films without one (unmatched, or too few ratings to
// average) go last in either direction; ties keep their original order.
function sortByRating(items, ratingOf, dir = "desc") {
  const sign = dir === "asc" ? 1 : -1;
  return items
    .map((item, i) => ({ item, i, r: ratingOf(item) ?? null }))
    .sort((a, b) => (a.r == null) - (b.r == null) || (a.r != null && sign * (a.r - b.r)) || a.i - b.i)
    .map(({ item }) => item);
}

// ---------- Catalog filters ----------
// The catalog page holds every row at once, so the filter bar narrows them in place. These are
// the rules. They cover only what Letterboxd knows and the site's own Advanced Filters can't ask:
// rating, runtime, and the user's own history. Genre, decade, country and director stay the
// site's. A film here is { rating, runtime, mark }, mark being the user's history (userMark).

// Wide bands: this catalog is full of shorts and serials, so "feature length or not" is the
// question, and a minute-level control would be false precision.
const RUNTIME_BANDS = [
  { value: "short", label: "Under 40 min", max: 40 },
  { value: "medium", label: "40 to 90 min", min: 40, max: 90 },
  { value: "feature", label: "90 to 120 min", min: 90, max: 120 },
  { value: "long", label: "Over 120 min", min: 120 },
];

const SEEN_OPTIONS = [
  { value: "all", label: "Everything" },
  { value: "unseen", label: "Not watched" },
  { value: "watched", label: "Watched" },
  { value: "watchlist", label: "On my watchlist" },
];

const MAX_MIN_RATING = 4.5; // above this the slider would empty the catalog
const DEFAULT_FILTERS = { minRating: 0, runtime: null, seen: "all" };

// Filters survive the page reloads the site's own sort and filters cause, so they come back from
// storage possibly written by an older version; matchesFilters assumes they've been through here.
function normalizeFilters(raw) {
  const minRating = Math.min(Math.max(+raw?.minRating || 0, 0), MAX_MIN_RATING);
  return {
    minRating: Math.round(minRating * 10) / 10,
    runtime: RUNTIME_BANDS.some((b) => b.value === raw?.runtime) ? raw.runtime : null,
    seen: SEEN_OPTIONS.some((o) => o.value === raw?.seen) ? raw.seen : "all",
  };
}

const isDefaultFilters = (f) => !f.minRating && !f.runtime && f.seen === "all";

// Bands are min-inclusive, max-exclusive, so a 90-minute film lands in "90 to 120" only.
function inRuntimeBand(runtime, value) {
  const band = RUNTIME_BANDS.find((b) => b.value === value);
  if (!band) return true;
  if (runtime == null) return false;
  return (band.min == null || runtime >= band.min) && (band.max == null || runtime < band.max);
}

function matchesSeen(mark, seen) {
  switch (seen) {
    case "unseen":
      return !mark?.watched;
    case "watched":
      return !!mark?.watched;
    case "watchlist":
      return !!mark?.watchlist;
    default:
      return true;
  }
}

// A film missing the fact a filter asks about — no Letterboxd match, no runtime in the snapshot
// yet — fails it rather than slipping through: an active filter should never show an unknown.
function matchesFilters(film, f) {
  if (f.minRating > 0 && !(film.rating >= f.minRating)) return false;
  if (f.runtime && !inRuntimeBand(film.runtime, f.runtime)) return false;
  return matchesSeen(film.mark, f.seen);
}

if (typeof module !== "undefined") {
  module.exports = {
    CATALOG_URL,
    parseCatalog,
    criterionSlug,
    splitDirectors,
    decodeEntities,
    sortByRating,
    RUNTIME_BANDS,
    SEEN_OPTIONS,
    MAX_MIN_RATING,
    DEFAULT_FILTERS,
    normalizeFilters,
    isDefaultFilters,
    inRuntimeBand,
    matchesFilters,
  };
}
