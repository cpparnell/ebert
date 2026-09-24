// A nightly GitHub Action resolves the whole Criterion catalog on Letterboxd once and publishes it
// (scripts/build-snapshot.js), so installs read one shared file instead of each scraping Letterboxd.
// Shape: { generatedAt, films: { [criterionId]: { title, year, directors, lb: { url, rating, ratingCount, runtime?, series? } | null } } }
const SNAPSHOT_URL = "https://cpparnell.github.io/ebert/snapshot.json";
const SNAPSHOT_KEY = "snapshot";

let snapshotIndexFor = null;
let snapshotIndex = null;

// lbKey -> lb result (null = the nightly run found no Letterboxd match), rebuilt when the snapshot changes.
function snapshotByKey(snapshot) {
  if (snapshotIndexFor !== snapshot) {
    snapshotIndex = new Map();
    for (const film of Object.values(snapshot?.films || {})) snapshotIndex.set(lbKey(film), film.lb);
    snapshotIndexFor = snapshot;
  }
  return snapshotIndex;
}

if (typeof module !== "undefined") {
  module.exports = { SNAPSHOT_URL, SNAPSHOT_KEY };
}
