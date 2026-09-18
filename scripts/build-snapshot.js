#!/usr/bin/env node
// Resolves the whole Criterion catalog on Letterboxd and writes the shared snapshot the extension
// reads (see lib/snapshot.js). Run nightly by .github/workflows/snapshot.yml; also runnable locally:
//   node scripts/build-snapshot.js [out=dist/snapshot.json]     (LIMIT=50 for a quick partial run)
const fs = require("fs");
const path = require("path");
const { parseFilmPage, isMatch, resolveFilm } = require("../lib/letterboxd.js");
const { parseCatalog, CATALOG_URL } = require("../lib/criterion.js");
const { SNAPSHOT_URL } = require("../lib/snapshot.js");

const OUT = process.argv[2] || "dist/snapshot.json";
const LIMIT = +process.env.LIMIT || Infinity;
const CONCURRENCY = 3;
const MAX_ERROR_RATE = 0.1; // above this, assume we're being blocked and publish nothing
const HEADERS = { "user-agent": "ebert-snapshot (+https://github.com/cpparnell/ebert)" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One shared pause: when Letterboxd says slow down, every worker waits.
let pausedUntil = 0;
async function politeFetch(url) {
  for (let attempt = 0; ; attempt++) {
    const wait = pausedUntil - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await fetch(url, { headers: HEADERS });
    if ((res.status !== 429 && res.status !== 503) || attempt >= 4) return res;
    const retryAfter = +res.headers.get("retry-after");
    pausedUntil = Date.now() + (retryAfter > 0 ? retryAfter * 1000 : 5000 * 2 ** attempt);
    console.warn(`throttled (${res.status}); pausing ${Math.round((pausedUntil - Date.now()) / 1000)}s`);
  }
}

const trim = (film) => film && { url: film.url, rating: film.rating, ratingCount: film.ratingCount };

// A film matched before is re-read from its known URL (one request); anything else is resolved from scratch.
async function resolve(film, previous) {
  if (previous?.lb?.url) {
    const res = await politeFetch(previous.lb.url);
    if (res.ok) {
      const found = parseFilmPage(await res.text());
      if (found && isMatch(found, film)) return trim(found);
    } else if (res.status !== 404) {
      throw new Error(`Letterboxd responded ${res.status} for ${previous.lb.url}`);
    }
  }
  return trim(await resolveFilm(film, politeFetch));
}

async function loadPrevious() {
  try {
    const res = await fetch(SNAPSHOT_URL, { headers: HEADERS });
    return res.ok ? (await res.json()).films || {} : {};
  } catch {
    return {};
  }
}

async function main() {
  const res = await fetch(CATALOG_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`catalog responded ${res.status}`);
  const catalog = parseCatalog(await res.text());
  const all = Object.keys(catalog).sort();
  if (all.length < 500) throw new Error(`catalog parsed to only ${all.length} films; layout changed?`);
  const slugs = all.slice(0, LIMIT);
  const previous = await loadPrevious();
  console.log(`${slugs.length} films in catalog, ${Object.keys(previous).length} in previous snapshot`);

  const films = {};
  let done = 0;
  let errors = 0;
  let next = 0;
  const worker = async () => {
    while (next < slugs.length) {
      const slug = slugs[next++];
      const film = catalog[slug];
      try {
        films[slug] = { ...film, lb: await resolve(film, previous[slug]) };
      } catch (err) {
        errors++;
        console.warn(`${slug}: ${err.message}`);
        // Keep last night's answer rather than dropping the film.
        if (previous[slug]) films[slug] = { ...film, lb: previous[slug].lb };
      }
      if (++done % 250 === 0) console.log(`${done}/${slugs.length} (${errors} errors)`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (errors > slugs.length * MAX_ERROR_RATE) {
    throw new Error(`${errors} of ${slugs.length} lookups failed; not publishing`);
  }
  const matched = Object.values(films).filter((f) => f.lb).length;
  console.log(`matched ${matched}/${slugs.length}, ${errors} errors`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), films }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
