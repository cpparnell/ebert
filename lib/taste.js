// Predicts what the user would rate a film, from how they've differed from Letterboxd's consensus
// on the films they've already rated. There is no training step and no model file: the model is a
// handful of shrunk averages, rebuilt in a few milliseconds whenever `user` or the snapshot changes.
//
// It models the RESIDUAL — their rating minus the consensus — and never the rating itself.
// Consensus already says whether a film is good; the residual is the only part that says anything
// about this particular viewer. Modelling raw ratings would just re-derive "good films score high",
// which is exactly what we already have from Letterboxd.
//
// Two levels, in order:
//   1. a global offset: they rate 0.3 above the crowd. Applied to everything — which means it
//      changes no ranking at all (a constant can't reorder), and exists only so a displayed number
//      is on their scale rather than the crowd's.
//   2. per-feature offsets — director, genre, decade, country — computed on residuals *net of*
//      that global offset, so each one measures "compared to how they usually differ". These are
//      the only terms that discriminate between films, and so the only ones that recommend.
//
// Every per-feature offset is shrunk toward zero by its sample size (`n / (n + SHRINK_K)`), which
// is what stops one well-liked Hungarian film from becoming "you love Hungarian cinema". A feature
// we know nothing about contributes nothing, so an unfamiliar film falls back toward consensus
// rather than toward a confident guess.
//
// Used by the content script; pure, so `node --test` covers it (tests/taste.test.js).
//
// !! MEASURED AND FOUND EMPTY (2026-09-23). Against a real 342-film history, leave-one-out, this
// beats raw consensus by 0.4% of a star — nothing. Out-of-fold the features correlate with the
// actual deviation at r = 0.13, and predictions span ±0.04 stars against a real spread of ±0.58:
// it predicts a near-constant because there is almost nothing to predict from. Do not wire this
// to a badge. `evaluateTaste` is how you'd check again; CLAUDE.md records the full numbers and
// the two findings worth keeping (genre carries the signal, not director; and a retry must train
// on the whole Letterboxd history, not the Criterion overlap).

// Below this many usable rated films we predict nothing at all. A model fitted on a dozen ratings
// is noise wearing a confident face, and a wrong prediction costs more trust than a missing one.
const TASTE_MIN_RATINGS = 30;

// Half weight at n = 4: how much evidence before a preference is believed rather than discounted.
const SHRINK_K = 4;

// A consensus averaged over a handful of people is itself too noisy to take a residual against.
const TASTE_MIN_RATING_COUNT = 30;

// A prediction carried only by the global offset is just consensus in a hat — it says nothing
// about the film. Unless the features clear this much evidence, we decline to answer.
const TASTE_MIN_EVIDENCE = 0.15;

const TASTE_RATING_MIN = 0.5;
const TASTE_RATING_MAX = 5;

// Relative strength of each signal, on deviations from the user's own average. Director leads
// because it's the most predictive thing about film taste and the cleanest data we hold; country
// trails because it's mostly a proxy for things the other three already capture.
const TASTE_FEATURES = [
  { key: "director", weight: 0.45 },
  { key: "genre", weight: 0.2 },
  { key: "decade", weight: 0.15 },
  { key: "country", weight: 0.1 },
];

// Feature values are compared, never displayed, so folding case and punctuation is enough:
// "Jean-Luc Godard" and "Jean Luc Godard" have to land on one key.
const tasteNorm = (s) =>
  String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const clampRating = (x) => Math.min(TASTE_RATING_MAX, Math.max(TASTE_RATING_MIN, x));

// One film as the model sees it. Directors and year come from the Criterion catalog record, genres
// and countries from its Letterboxd entry, so this takes both rather than one merged object.
function tasteFeatures(film, lb) {
  const values = {
    director: (film?.directors || []).map(tasteNorm),
    genre: (lb?.genres || []).map(tasteNorm),
    decade: film?.year ? [`${Math.floor(film.year / 10) * 10}s`] : [],
    country: (lb?.countries || []).map(tasteNorm),
  };
  for (const key of Object.keys(values)) values[key] = [...new Set(values[key].filter(Boolean))];
  return values;
}

// The rated films the model can learn from, drawn from the snapshot so each one arrives with the
// consensus and the features beside it. Skipped: films they logged without a rating (no signal),
// films with no or barely-rated consensus (the residual would be mostly noise in the baseline),
// and series installments, whose Letterboxd rating belongs to the whole work while the user's
// rating belongs to the episode — subtracting one from the other measures nothing.
function tasteSamples(snapshot, user, lbSlugOf) {
  const watched = user?.watched || {};
  const out = [];
  for (const film of Object.values(snapshot?.films || {})) {
    const lb = film?.lb;
    if (!lb || lb.series || lb.rating == null) continue;
    if ((lb.ratingCount || 0) < TASTE_MIN_RATING_COUNT) continue;
    const slug = lbSlugOf(lb.url);
    const rating = slug ? watched[slug] : 0;
    if (!rating) continue; // absent, or watched but unrated
    out.push({ slug, rating, consensus: lb.rating, film, lb });
  }
  return out;
}

// Sums and counts per feature value, so pooling several values of one feature (a film with two
// directors, three genres) is exact rather than an average of averages.
function accumulate(samples, centered) {
  const byFeature = {};
  for (const { key } of TASTE_FEATURES) byFeature[key] = new Map();
  samples.forEach((sample, i) => {
    const values = tasteFeatures(sample.film, sample.lb);
    for (const { key } of TASTE_FEATURES) {
      const map = byFeature[key];
      for (const value of values[key]) {
        const cell = map.get(value) || { sum: 0, n: 0 };
        cell.sum += centered[i];
        cell.n++;
        map.set(value, cell);
      }
    }
  });
  return byFeature;
}

// null when there isn't enough history to say anything — the caller shows consensus alone.
function buildTasteModel(samples, { k = SHRINK_K, minRatings = TASTE_MIN_RATINGS } = {}) {
  if (!samples || samples.length < minRatings) return null;
  const residuals = samples.map((s) => s.rating - s.consensus);
  const globalOffset = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  // Feature offsets are deviations from the user's own average, not from the crowd's: shrinking
  // toward zero then means "this director is unremarkable *for them*", which is the right prior.
  // Shrinking raw residuals would instead drag every sparse feature back toward the crowd.
  return {
    n: samples.length,
    k,
    globalOffset,
    byFeature: accumulate(samples, residuals.map((r) => r - globalOffset)),
  };
}

// { score, delta, evidence, basis } or null when the model has nothing specific to say about this
// film — an unfamiliar director, genre and country leave only the global offset, which is no
// information at all. Declining is deliberate: a prediction is worth less than an honest blank.
function predictRating(model, film, lb, { minEvidence = TASTE_MIN_EVIDENCE } = {}) {
  if (!model || lb?.rating == null) return null;
  const values = tasteFeatures(film, lb);
  let delta = 0;
  let evidence = 0;
  const basis = [];
  for (const { key, weight } of TASTE_FEATURES) {
    let sum = 0;
    let n = 0;
    for (const value of values[key]) {
      const cell = model.byFeature[key]?.get(value);
      if (cell) {
        sum += cell.sum;
        n += cell.n;
      }
    }
    if (!n) continue;
    const shrink = n / (n + model.k);
    const offset = (sum / n) * shrink;
    delta += weight * offset;
    evidence += weight * shrink;
    basis.push({ feature: key, n, offset });
  }
  if (evidence < minEvidence) return null;
  return {
    score: clampRating(lb.rating + model.globalOffset + delta),
    delta: model.globalOffset + delta,
    evidence,
    // Strongest signal first: this is what a "because you like…" line would read from.
    basis: basis.sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset)),
  };
}

// Leave-one-out over the user's own history — the only honest test available, since there is no
// held-out set and never will be. Each film is predicted by a model rebuilt without it, and scored
// against two baselines: raw consensus, and consensus shifted by the global offset. Beating the
// first is easy and means little; beating `centeredMae` is the one that matters, because it asks
// whether the per-feature terms know anything beyond "this user rates high".
//
// If the model doesn't beat that, the honest move is to ship consensus and skip all of this.
function evaluateTaste(samples, opts = {}) {
  let n = 0;
  let model = 0;
  let baseline = 0;
  let centered = 0;
  for (let i = 0; i < samples.length; i++) {
    const rest = samples.filter((_, j) => j !== i);
    const built = buildTasteModel(rest, opts);
    if (!built) continue;
    const predicted = predictRating(built, samples[i].film, samples[i].lb, opts);
    if (!predicted) continue; // declined; counted in coverage, not in the error
    n++;
    model += Math.abs(predicted.score - samples[i].rating);
    baseline += Math.abs(samples[i].consensus - samples[i].rating);
    centered += Math.abs(clampRating(samples[i].consensus + built.globalOffset) - samples[i].rating);
  }
  if (!n) return { n: 0, coverage: 0, mae: null, baselineMae: null, centeredMae: null, beatsBaseline: false };
  const mae = model / n;
  const centeredMae = centered / n;
  return {
    n,
    coverage: n / samples.length,
    mae,
    baselineMae: baseline / n,
    centeredMae,
    beatsBaseline: mae < centeredMae,
  };
}

// Ranking is not prediction. Sorting purely by score returns five films by the same director and a
// bad time, so the best score per director is kept and the rest of their filmography drops out.
// `excludeWatched` is on because a recommender that recommends what you've seen isn't one.
function recommendFilms(model, entries, { limit = 20, perDirector = 1, watched = {}, lbSlugOf } = {}) {
  const scored = [];
  for (const { film, lb } of entries) {
    if (!lb) continue;
    if (lbSlugOf && watched[lbSlugOf(lb.url)] !== undefined) continue;
    const predicted = predictRating(model, film, lb);
    if (predicted) scored.push({ film, lb, ...predicted });
  }
  scored.sort((a, b) => b.score - a.score || (b.lb.ratingCount || 0) - (a.lb.ratingCount || 0));
  const seen = new Map();
  const out = [];
  for (const entry of scored) {
    const directors = (entry.film.directors || []).map(tasteNorm);
    const key = directors[0] || `~${entry.film.title}`;
    const used = seen.get(key) || 0;
    if (used >= perDirector) continue;
    seen.set(key, used + 1);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

if (typeof module !== "undefined") {
  module.exports = {
    TASTE_MIN_RATINGS,
    TASTE_MIN_RATING_COUNT,
    TASTE_MIN_EVIDENCE,
    TASTE_FEATURES,
    SHRINK_K,
    tasteNorm,
    tasteFeatures,
    tasteSamples,
    buildTasteModel,
    predictRating,
    evaluateTaste,
    recommendFilms,
  };
}
