const test = require("node:test");
const assert = require("node:assert");
const {
  TASTE_MIN_RATINGS,
  tasteNorm,
  tasteFeatures,
  tasteSamples,
  buildTasteModel,
  predictRating,
  evaluateTaste,
  recommendFilms,
} = require("../lib/taste.js");
const { lbSlug } = require("../lib/user.js");

// A film the snapshot would carry, with enough raters to be usable as a sample.
const film = (title, { year = 1966, directors = ["Robert Bresson"], genres = ["Drama"], countries = ["France"], ...lb } = {}) => ({
  film: { title, year, directors },
  lb: { url: `https://letterboxd.com/film/${title}/`, rating: 3.5, ratingCount: 1000, genres, countries, ...lb },
});

// `count` rated films that differ from consensus by `delta`, so a feature's offset is known exactly.
function samples(count, delta, opts = {}) {
  return Array.from({ length: count }, (_, i) => {
    const { film: f, lb } = film(`f${opts.tag || ""}${i}`, opts);
    return { slug: `f${opts.tag || ""}${i}`, rating: lb.rating + delta, consensus: lb.rating, film: f, lb };
  });
}

test("tasteNorm folds case, accents and punctuation onto one key", () => {
  assert.equal(tasteNorm("Jean-Luc Godard"), tasteNorm("Jean Luc Godard"));
  assert.equal(tasteNorm("Agnès Varda"), "agnesvarda");
  assert.equal(tasteNorm(null), "");
});

test("tasteFeatures reads directors and year from Criterion, genres and countries from Letterboxd", () => {
  const { film: f, lb } = film("x", { year: 1954, directors: ["Akira Kurosawa"], genres: ["Drama", "Action"], countries: ["Japan"] });
  assert.deepEqual(tasteFeatures(f, lb), {
    director: ["akirakurosawa"],
    genre: ["drama", "action"],
    decade: ["1950s"],
    country: ["japan"],
  });
});

test("tasteFeatures survives a film missing every feature", () => {
  assert.deepEqual(tasteFeatures(null, null), { director: [], genre: [], decade: [], country: [] });
});

test("tasteSamples keeps rated films and drops the ones that carry no usable signal", () => {
  const films = {
    rated: film("rated").lb && { ...film("rated").film, lb: film("rated").lb },
    unrated: { ...film("unrated").film, lb: film("unrated").lb },
    unseen: { ...film("unseen").film, lb: film("unseen").lb },
    obscure: { ...film("obscure").film, lb: { ...film("obscure").lb, ratingCount: 4 } },
    episode: { ...film("episode").film, lb: { ...film("episode").lb, series: true } },
    unmatched: { ...film("unmatched").film, lb: null },
  };
  const user = {
    watched: { rated: 4.5, unrated: 0, obscure: 5, episode: 5 },
  };
  const got = tasteSamples({ films }, user, lbSlug);
  assert.deepEqual(
    got.map((s) => s.slug),
    ["rated"]
  );
  assert.equal(got[0].rating, 4.5);
  assert.equal(got[0].consensus, 3.5);
});

test("buildTasteModel declines below the minimum, rather than fitting noise", () => {
  assert.equal(buildTasteModel(samples(TASTE_MIN_RATINGS - 1, 0.5)), null);
  assert.equal(buildTasteModel([]), null);
  assert.equal(buildTasteModel(null), null);
  assert.ok(buildTasteModel(samples(TASTE_MIN_RATINGS, 0.5)));
});

test("a user who rates uniformly high gets that offset back, and no feature opinions", () => {
  const model = buildTasteModel(samples(40, 0.5));
  assert.ok(Math.abs(model.globalOffset - 0.5) < 1e-9);
  // Every sample deviates from their own average by zero, so no feature claims anything.
  const { film: f, lb } = film("new");
  const predicted = predictRating(model, f, lb);
  assert.ok(Math.abs(predicted.score - (lb.rating + 0.5)) < 1e-9);
  for (const b of predicted.basis) assert.ok(Math.abs(b.offset) < 1e-9);
});

test("a director rated above the user's own average lifts the prediction", () => {
  const model = buildTasteModel([
    ...samples(30, 0, { tag: "base", directors: ["Yasujiro Ozu"], genres: ["Drama"], countries: ["Japan"] }),
    ...samples(10, 1, { tag: "loved", directors: ["Robert Bresson"], genres: ["Drama"], countries: ["France"] }),
  ]);
  const bresson = film("new-bresson", { directors: ["Robert Bresson"], countries: ["France"] });
  const ozu = film("new-ozu", { directors: ["Yasujiro Ozu"], countries: ["Japan"] });
  const a = predictRating(model, bresson.film, bresson.lb);
  const b = predictRating(model, ozu.film, ozu.lb);
  assert.ok(a.score > b.score, `${a.score} should beat ${b.score}`);
  assert.equal(a.basis[0].feature, "director");
});

test("shrinkage keeps one enthusiastic data point from becoming a preference", () => {
  const base = samples(40, 0, { tag: "base", directors: ["Yasujiro Ozu"], countries: ["Japan"] });
  const one = samples(1, 2, { tag: "fluke", directors: ["Bela Tarr"], countries: ["Hungary"] });
  const many = samples(20, 2, { tag: "real", directors: ["Bela Tarr"], countries: ["Hungary"] });
  const target = film("new-tarr", { directors: ["Bela Tarr"], countries: ["Hungary"] });

  const weak = predictRating(buildTasteModel([...base, ...one]), target.film, target.lb);
  const strong = predictRating(buildTasteModel([...base, ...many]), target.film, target.lb);
  // Same +2 residual, twenty times the evidence: the offset it earns is far larger.
  assert.ok(strong.delta > weak.delta * 3, `${strong.delta} vs ${weak.delta}`);
});

test("predictRating declines when only the global offset would carry it", () => {
  const model = buildTasteModel(samples(40, 0.5, { directors: ["Robert Bresson"], genres: ["Drama"], countries: ["France"] }));
  const stranger = film("unknown", {
    year: 2021,
    directors: ["Nobody At All"],
    genres: ["Sci-Fi"],
    countries: ["Iceland"],
  });
  assert.equal(predictRating(model, stranger.film, stranger.lb), null);
});

test("predictRating declines without a consensus to build on, and without a model", () => {
  const model = buildTasteModel(samples(40, 0.5));
  const { film: f, lb } = film("no-rating", { rating: null });
  assert.equal(predictRating(model, f, lb), null);
  assert.equal(predictRating(null, f, film("x").lb), null);
});

test("predictions stay inside Letterboxd's 0.5–5 scale", () => {
  const model = buildTasteModel(samples(40, 2.5, { directors: ["Robert Bresson"] }));
  const top = film("top", { rating: 4.8, directors: ["Robert Bresson"] });
  assert.equal(predictRating(model, top.film, top.lb).score, 5);

  const low = buildTasteModel(samples(40, -3, { directors: ["Robert Bresson"] }));
  const bottom = film("bottom", { rating: 1, directors: ["Robert Bresson"] });
  assert.equal(predictRating(low, bottom.film, bottom.lb).score, 0.5);
});

test("evaluateTaste recovers a real per-director pattern from held-out films", () => {
  // Two directors the user splits on, either side of their own average: learnable by construction.
  const set = [
    ...samples(25, 0.8, { tag: "up", directors: ["Robert Bresson"], countries: ["France"] }),
    ...samples(25, -0.8, { tag: "down", directors: ["Michael Bay"], countries: ["USA"] }),
  ];
  const report = evaluateTaste(set);
  assert.ok(report.n > 40, `evaluated only ${report.n}`);
  assert.ok(report.beatsBaseline, `mae ${report.mae} vs centered ${report.centeredMae}`);
  // Not all the way to zero, and deliberately so: the four features are a weighted average of
  // correlated estimators, and here genre and decade are identical across both groups, so they
  // correctly report "nothing to add" and dilute the director's call. Cutting the error by a
  // third against the baseline is the claim worth making; a specific MAE isn't.
  assert.ok(report.mae < report.centeredMae * 0.7, `mae ${report.mae} vs centered ${report.centeredMae}`);
});

test("evaluateTaste reports no win when the user simply agrees with everyone", () => {
  // Residuals are pure noise around zero: there is nothing for a feature to learn, and saying so
  // is the point of the harness.
  const set = samples(60, 0, { directors: ["Robert Bresson"] }).map((s, i) => ({
    ...s,
    rating: s.consensus + (i % 2 ? 0.5 : -0.5),
  }));
  const report = evaluateTaste(set);
  assert.ok(!report.beatsBaseline || report.mae >= report.centeredMae - 1e-9);
});

test("evaluateTaste reports nothing rather than dividing by zero on a short history", () => {
  assert.deepEqual(evaluateTaste(samples(3, 0.5)), {
    n: 0,
    coverage: 0,
    mae: null,
    baselineMae: null,
    centeredMae: null,
    beatsBaseline: false,
  });
});

test("recommendFilms skips what's been watched and won't stack one director", () => {
  const model = buildTasteModel([
    ...samples(30, 0, { tag: "base", directors: ["Yasujiro Ozu"], countries: ["Japan"] }),
    ...samples(15, 1, { tag: "loved", directors: ["Robert Bresson"], countries: ["France"] }),
  ]);
  const entries = [
    film("pickpocket", { directors: ["Robert Bresson"], countries: ["France"] }),
    film("mouchette", { directors: ["Robert Bresson"], countries: ["France"] }),
    film("tokyo-story", { directors: ["Yasujiro Ozu"], countries: ["Japan"] }),
    film("seen-it", { directors: ["Robert Bresson"], countries: ["France"], rating: 4.9 }),
  ];
  const out = recommendFilms(model, entries, {
    watched: { "seen-it": 5 },
    lbSlugOf: lbSlug,
  });
  const titles = out.map((e) => e.film.title);
  assert.ok(!titles.includes("seen-it"), "recommended a film already watched");
  assert.equal(titles.filter((t) => t === "mouchette" || t === "pickpocket").length, 1, "stacked one director");
  assert.ok(titles.includes("tokyo-story"));
});

test("recommendFilms honours its limit and drops films it can't speak to", () => {
  const model = buildTasteModel(samples(40, 0.5, { directors: ["Robert Bresson"], genres: ["Drama"], countries: ["France"] }));
  const entries = [
    film("a", { directors: ["Robert Bresson"] }),
    film("b", { directors: ["Agnes Varda"] }),
    { film: { title: "c", year: 1966, directors: ["Robert Bresson"] }, lb: null },
    film("d", { year: 2020, directors: ["Nobody"], genres: ["Sci-Fi"], countries: ["Iceland"] }),
  ];
  const out = recommendFilms(model, entries, { limit: 1, watched: {}, lbSlugOf: lbSlug });
  assert.equal(out.length, 1);
  assert.ok(!recommendFilms(model, entries, { watched: {}, lbSlugOf: lbSlug }).some((e) => e.film.title === "d"));
});
