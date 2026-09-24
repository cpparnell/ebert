#!/usr/bin/env node
// Resolves the whole Criterion catalog on Letterboxd and writes the shared snapshot the extension
// reads (see lib/snapshot.js). Run nightly by .github/workflows/snapshot.yml; also runnable locally:
//   node scripts/build-snapshot.js [out=dist/snapshot.json]
// LIMIT=50 caps the run; ONLY=la-piscine,xiao-wu resolves just those slugs (debugging one film).
const fs = require("fs");
const path = require("path");
const { parseFilmPage, isMatch, resolveFilm, titleVariants } = require("../lib/letterboxd.js");
const { parseCatalog, CATALOG_URL } = require("../lib/criterion.js");
const { SNAPSHOT_URL } = require("../lib/snapshot.js");
const { resolveViaWikidata } = require("./wikidata.js");

const OUT = process.argv[2] || "dist/snapshot.json";
const LIMIT = +process.env.LIMIT || Infinity;
// Debugging one film's matching without waiting out the catalog: ONLY=la-piscine,les-creatures.
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;
const CONCURRENCY = 1; // one request at a time (~2/s, ~30 min a run): nothing needs it faster
const MAX_ERROR_RATE = 0.1; // above this, assume we're being blocked and publish nothing
const HEADERS = { "user-agent": "ebert-snapshot (+https://github.com/cpparnell/ebert)" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One shared pause per host: when a site says slow down, every worker waits on that site only, so
// Wikidata throttling never stalls the Letterboxd crawl or the other way round.
function politeFetcher(name) {
  let pausedUntil = 0;
  return async function politeFetch(url) {
    for (let attempt = 0; ; attempt++) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const res = await fetch(url, { headers: HEADERS });
      if ((res.status !== 429 && res.status !== 503) || attempt >= 4) return res;
      const retryAfter = +res.headers.get("retry-after");
      pausedUntil = Date.now() + (retryAfter > 0 ? retryAfter * 1000 : 5000 * 2 ** attempt);
      console.warn(`${name} throttled (${res.status}); pausing ${Math.round((pausedUntil - Date.now()) / 1000)}s`);
    }
  };
}

const politeFetch = politeFetcher("letterboxd");
const wikidataFetch = politeFetcher("wikidata");

// Installments ("Carlos: Part 2") always record `series`: whether the rating is the whole work's.
const trim = (film, installment) =>
  film && {
    url: film.url,
    rating: film.rating,
    ratingCount: film.ratingCount,
    ...(film.runtime && { runtime: film.runtime }),
    ...(installment && { series: !!film.series }),
  };

let wikidataHits = 0;
let wikidataErrors = 0;

// Letterboxd's search is the fallback `resolveFilm` uses for a title whose slug can't be guessed,
// and Cloudflare 403s it for this Action (see scripts/wikidata.js). Wikidata stands in for it, so
// films Criterion lists under a title Letterboxd doesn't use still resolve. It costs a couple of
// requests and only runs for films nothing else matched, which is ~200 of 3,300 — and a film it
// matches is re-read from its own URL on later runs, so the cost doesn't recur.
async function viaWikidata(film) {
  try {
    const found = await resolveViaWikidata(film, wikidataFetch, politeFetch);
    if (found) {
      wikidataHits++;
      console.log(`wikidata: ${film.title} (${film.year}) -> ${found.url}`);
    }
    return found;
  } catch (err) {
    // Wikidata being down or slow shouldn't fail films that simply have no Letterboxd match, or
    // push the run past MAX_ERROR_RATE and block publishing. Degrade to the pre-Wikidata result.
    wikidataErrors++;
    console.warn(`wikidata failed for ${film.title}: ${err.message}`);
    return null;
  }
}

// A film matched before is re-read from its known URL (one request); anything else is resolved from
// scratch, as is an installment from a snapshot that predates the `series` flag.
async function resolve(film, previous) {
  const installment = titleVariants(film.title).length > 1;
  if (previous?.lb?.url && (!installment || "series" in previous.lb)) {
    const res = await politeFetch(previous.lb.url);
    if (res.ok) {
      const found = parseFilmPage(await res.text());
      if (found && isMatch(found, film)) return trim({ ...found, series: previous.lb.series }, installment);
    } else if (res.status !== 404) {
      throw new Error(`Letterboxd responded ${res.status} for ${previous.lb.url}`);
    }
  }
  const found = (await resolveFilm(film, politeFetch)) || (await viaWikidata(film));
  return trim(found, installment);
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
  const slugs = (ONLY ? all.filter((s) => ONLY.has(s)) : all).slice(0, LIMIT);
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
        films[slug] = { ...film, lb: await resolve({ ...film, slug }, previous[slug]) };
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
  console.log(
    `matched ${matched}/${slugs.length}, ${errors} errors ` +
      `(${wikidataHits} matched via wikidata, ${wikidataErrors} wikidata failures)`
  );

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), films }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
