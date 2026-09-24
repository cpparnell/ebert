const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sortByRating,
  normalizeFilters,
  isDefaultFilters,
  inRuntimeBand,
  matchesFilters,
  DEFAULT_FILTERS,
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
    runtime: null,
    seen: "watched",
  });
  // Out of range, and values no control can produce.
  assert.deepEqual(normalizeFilters({ minRating: 9, runtime: "epic", seen: "nope" }), {
    minRating: 4.5,
    runtime: null,
    seen: "all",
  });
  // Decade and country were dropped; leftovers from an older version don't come back.
  assert.deepEqual(normalizeFilters({ decades: [1960], countries: ["Japan"] }), DEFAULT_FILTERS);
  assert.ok(isDefaultFilters(normalizeFilters({})));
  assert.ok(!isDefaultFilters(normalizeFilters({ seen: "unseen" })));
});

test("runtime bands are min-inclusive and max-exclusive, and exclude unknown runtimes", () => {
  assert.ok(inRuntimeBand(39, "short"));
  assert.ok(!inRuntimeBand(40, "short"));
  assert.ok(inRuntimeBand(40, "medium"));
  assert.ok(inRuntimeBand(90, "feature"));
  assert.ok(!inRuntimeBand(120, "feature"));
  assert.ok(inRuntimeBand(207, "long"));
  assert.ok(!inRuntimeBand(null, "long"));
  assert.ok(inRuntimeBand(null, null)); // no band chosen: everything passes
});

const seven = { rating: 4.5, runtime: 207, mark: null };

test("matchesFilters lets everything through by default", () => {
  assert.ok(matchesFilters({ rating: null, runtime: null }, DEFAULT_FILTERS));
});

test("matchesFilters combines rating, runtime and watched state", () => {
  const f = (patch) => normalizeFilters({ ...DEFAULT_FILTERS, ...patch });
  assert.ok(matchesFilters(seven, f({ minRating: 4.2 })));
  assert.ok(!matchesFilters({ ...seven, rating: 3.9 }, f({ minRating: 4.2 })));
  assert.ok(matchesFilters(seven, f({ runtime: "long" })));
  assert.ok(!matchesFilters(seven, f({ runtime: "feature" })));
  // Both at once; the runtime alone disagrees.
  assert.ok(matchesFilters(seven, f({ minRating: 4, runtime: "long" })));
  assert.ok(!matchesFilters(seven, f({ minRating: 4, runtime: "short" })));
});

test("an active filter hides a film whose rating or runtime isn't known yet", () => {
  const unknown = { rating: null, runtime: null, mark: null };
  assert.ok(matchesFilters(unknown, DEFAULT_FILTERS));
  assert.ok(!matchesFilters(unknown, normalizeFilters({ minRating: 0.1 })));
  assert.ok(!matchesFilters(unknown, normalizeFilters({ runtime: "short" })));
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
