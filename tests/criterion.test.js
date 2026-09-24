const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sortByRating,
  normalizeFilters,
  isDefaultFilters,
  inRuntimeRange,
  matchesFilters,
  DEFAULT_FILTERS,
  RUNTIME_MIN,
  RUNTIME_MAX,
} = require("../lib/criterion.js");

const films = [
  { t: "a", r: 3.1 },
  { t: "b", r: null }, // no Letterboxd match / too few ratings
  { t: "c", r: 4.2 },
  { t: "d", r: undefined }, // not looked up yet
  { t: "e", r: 3.1 },
  { t: "f", r: 0.9 },
];
const order = (dir) => sortByRating(films, (f) => f.r, dir).map((f) => f.t).join("");

test("sortByRating puts the highest rated first by default", () => {
  assert.equal(order(), "caefbd");
  assert.equal(order("desc"), "caefbd");
});

test("sortByRating ascending still leaves unrated films last", () => {
  assert.equal(order("asc"), "faecbd");
});

test("sortByRating keeps ties in their original order and doesn't mutate its input", () => {
  const copy = [...films];
  sortByRating(films, (f) => f.r);
  assert.deepEqual(films, copy);
  assert.deepEqual(sortByRating([], (f) => f), []);
});

test("normalizeFilters repairs whatever comes back from storage", () => {
  assert.deepEqual(normalizeFilters(undefined), DEFAULT_FILTERS);
  assert.deepEqual(normalizeFilters({ minRating: "3.7", seen: "watched" }), {
    minRating: 3.7,
    runtimeMin: RUNTIME_MIN,
    runtimeMax: RUNTIME_MAX,
    seen: "watched",
  });
  // Out of range, and values no control can produce. An unreadable bound opens back up rather
  // than hiding rows nothing can bring back.
  assert.deepEqual(normalizeFilters({ minRating: 9, runtimeMin: 5, runtimeMax: "wide", seen: "nope" }), {
    minRating: 4.5,
    runtimeMin: RUNTIME_MIN,
    runtimeMax: RUNTIME_MAX,
    seen: "all",
  });
  // Off-step values snap to the slider's own stops.
  assert.deepEqual(normalizeFilters({ runtimeMin: 63, runtimeMax: 141.5 }), {
    ...DEFAULT_FILTERS,
    runtimeMin: 65,
    runtimeMax: 140,
  });
  // A crossed pair would match nothing; the low bound gives way.
  assert.deepEqual(normalizeFilters({ runtimeMin: 150, runtimeMax: 90 }), {
    ...DEFAULT_FILTERS,
    runtimeMin: 90,
    runtimeMax: 90,
  });
  // The old band filter is gone; a value stored by that version doesn't come back as one.
  assert.ok(isDefaultFilters(normalizeFilters({ runtime: "short" })));
  // Decade and country were dropped; leftovers from an older version don't come back.
  assert.deepEqual(normalizeFilters({ decades: [1960], countries: ["Japan"] }), DEFAULT_FILTERS);
  assert.ok(isDefaultFilters(normalizeFilters({})));
  assert.ok(!isDefaultFilters(normalizeFilters({ seen: "unseen" })));
});

const range = (runtimeMin, runtimeMax) => normalizeFilters({ runtimeMin, runtimeMax });

test("a runtime handle resting on an end is no bound there", () => {
  // The whole track: nothing is being asked, so even an unknown runtime passes.
  assert.ok(inRuntimeRange(null, range(RUNTIME_MIN, RUNTIME_MAX)));
  // "40 min and under" reaches below the slider's own floor.
  assert.ok(inRuntimeRange(12, range(RUNTIME_MIN, RUNTIME_MIN)));
  assert.ok(!inRuntimeRange(45, range(RUNTIME_MIN, RUNTIME_MIN)));
  // "180 min and over" reaches past its ceiling.
  assert.ok(inRuntimeRange(566, range(RUNTIME_MAX, RUNTIME_MAX)));
  assert.ok(!inRuntimeRange(120, range(RUNTIME_MAX, RUNTIME_MAX)));
});

test("a runtime range is inclusive at both ends, and excludes unknown runtimes", () => {
  assert.ok(inRuntimeRange(90, range(90, 120)));
  assert.ok(inRuntimeRange(120, range(90, 120)));
  assert.ok(!inRuntimeRange(85, range(90, 120)));
  assert.ok(!inRuntimeRange(125, range(90, 120)));
  assert.ok(!inRuntimeRange(null, range(90, 120)));
});

const seven = { rating: 4.5, runtime: 207, mark: null };

test("matchesFilters lets everything through by default", () => {
  assert.ok(matchesFilters({ rating: null, runtime: null }, DEFAULT_FILTERS));
});

test("matchesFilters combines rating, runtime and watched state", () => {
  const f = (patch) => normalizeFilters({ ...DEFAULT_FILTERS, ...patch });
  assert.ok(matchesFilters(seven, f({ minRating: 4.2 })));
  assert.ok(!matchesFilters({ ...seven, rating: 3.9 }, f({ minRating: 4.2 })));
  assert.ok(matchesFilters(seven, f({ runtimeMin: RUNTIME_MAX })));
  assert.ok(!matchesFilters(seven, f({ runtimeMin: 90, runtimeMax: 120 })));
  // Both at once; the runtime alone disagrees.
  assert.ok(matchesFilters(seven, f({ minRating: 4, runtimeMin: RUNTIME_MAX })));
  assert.ok(!matchesFilters(seven, f({ minRating: 4, runtimeMax: RUNTIME_MIN })));
});

test("an active filter hides a film whose rating or runtime isn't known yet", () => {
  const unknown = { rating: null, runtime: null, mark: null };
  assert.ok(matchesFilters(unknown, DEFAULT_FILTERS));
  assert.ok(!matchesFilters(unknown, normalizeFilters({ minRating: 0.1 })));
  assert.ok(!matchesFilters(unknown, normalizeFilters({ runtimeMax: RUNTIME_MIN })));
  // The watched filter asks about the user, not the film, so it still answers.
  assert.ok(matchesFilters(unknown, normalizeFilters({ seen: "unseen" })));
});

test("the watched filter reads the user's own mark", () => {
  const marks = {
    none: null,
    watched: { watched: true, rating: 4, watchlist: false },
    unrated: { watched: true, rating: null, watchlist: false },
    listed: { watched: false, rating: null, watchlist: true },
  };
  const passes = (seen) =>
    Object.entries(marks)
      .filter(([, mark]) => matchesFilters({ ...seven, mark }, normalizeFilters({ seen })))
      .map(([name]) => name);
  assert.deepEqual(passes("all"), ["none", "watched", "unrated", "listed"]);
  assert.deepEqual(passes("unseen"), ["none", "listed"]);
  assert.deepEqual(passes("watched"), ["watched", "unrated"]);
  assert.deepEqual(passes("watchlist"), ["listed"]);
});
