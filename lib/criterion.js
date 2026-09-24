// Rules for sorting and filtering All Films by what Letterboxd knows. Pure, so they're tested in
// Node; the controls and the results grid are in content.js.

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

// Runtime is a range with clamped ends. The catalog runs from two-minute fragments to serials
// hours long, so the ends stand for "and under" and "and over" rather than real limits: a handle
// resting on one is no bound at all. That keeps the useful middle — roughly 40 to 180 minutes,
// where nearly every feature sits — spread across the whole track instead of squeezed into a
// corner of it.
const RUNTIME_MIN = 40;
const RUNTIME_MAX = 180;
const RUNTIME_STEP = 5;

const SEEN_OPTIONS = [
  { value: "all", label: "Everything" },
  { value: "unseen", label: "Not watched" },
  { value: "watched", label: "Watched" },
  { value: "watchlist", label: "On my watchlist" },
];

const MAX_MIN_RATING = 4.5; // above this the slider would empty the catalog
const DEFAULT_FILTERS = { minRating: 0, runtimeMin: RUNTIME_MIN, runtimeMax: RUNTIME_MAX, seen: "all" };

// Snaps to the slider's own step and range; anything unusable falls back to the open end, so a
// filter that can't be read is a filter that isn't applied.
function clampRuntime(value, fallback) {
  const n = Math.round(+value / RUNTIME_STEP) * RUNTIME_STEP;
  return Number.isFinite(n) && n >= RUNTIME_MIN && n <= RUNTIME_MAX ? n : fallback;
}

// Filters survive the page reloads the site's own sort and filters cause, so they come back from
// storage possibly written by an older version; matchesFilters assumes they've been through here.
function normalizeFilters(raw) {
  const minRating = Math.min(Math.max(+raw?.minRating || 0, 0), MAX_MIN_RATING);
  const runtimeMax = clampRuntime(raw?.runtimeMax, RUNTIME_MAX);
  return {
    minRating: Math.round(minRating * 10) / 10,
    // A crossed pair would match nothing and read as a bug rather than a choice.
    runtimeMin: Math.min(clampRuntime(raw?.runtimeMin, RUNTIME_MIN), runtimeMax),
    runtimeMax,
    seen: SEEN_OPTIONS.some((o) => o.value === raw?.seen) ? raw.seen : "all",
  };
}

const hasRuntimeFilter = (f) => f.runtimeMin > RUNTIME_MIN || f.runtimeMax < RUNTIME_MAX;

const isDefaultFilters = (f) => !f.minRating && !hasRuntimeFilter(f) && f.seen === "all";

// Inclusive at both ends, the way the label reads it ("40 to 90 min" takes a 90-minute film). A
// handle parked on an end is no bound there, so a 12-minute short passes a range starting at 40.
function inRuntimeRange(runtime, f) {
  if (!hasRuntimeFilter(f)) return true;
  if (runtime == null) return false;
  if (f.runtimeMin > RUNTIME_MIN && runtime < f.runtimeMin) return false;
  if (f.runtimeMax < RUNTIME_MAX && runtime > f.runtimeMax) return false;
  return true;
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
  if (!inRuntimeRange(film.runtime, f)) return false;
  return matchesSeen(film.mark, f.seen);
}

if (typeof module !== "undefined") {
  module.exports = {
    sortByRating,
    RUNTIME_MIN,
    RUNTIME_MAX,
    RUNTIME_STEP,
    SEEN_OPTIONS,
    MAX_MIN_RATING,
    DEFAULT_FILTERS,
    normalizeFilters,
    isDefaultFilters,
    hasRuntimeFilter,
    inRuntimeRange,
    matchesFilters,
  };
}
