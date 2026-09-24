#!/usr/bin/env node
// Resolves the whole Criterion catalog on Letterboxd and writes the shared snapshot the extension
// reads (see lib/snapshot.js). Run nightly by .github/workflows/snapshot.yml; also runnable locally:
//   node scripts/build-snapshot.js [out=dist/snapshot.json]
// LIMIT=50 caps the run; ONLY=la-piscine,xiao-wu resolves just those films (debugging one film).
const fs = require("fs");
const path = require("path");
const { parseFilmPage, isMatch, resolveFilm, titleVariants, slugify, lbKey } = require("../lib/letterboxd.js");
const { allFilmsUrl, mediaUrl, parseAllFilms, parseMedia } = require("../lib/site.js");
const { SNAPSHOT_URL } = require("../lib/snapshot.js");
const { resolveViaWikidata } = require("./wikidata.js");

const OUT = process.argv[2] || "dist/snapshot.json";
const LIMIT = +process.env.LIMIT || Infinity;
// Debugging one film's matching without waiting out the catalog: ONLY=la-piscine,les-creatures.
// Each entry is a title as a slug, or a Criterion media id (the L5Z3RaiC in /films/L5Z3RaiC/…).
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
const criterionFetch = politeFetcher("criterion");

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

// Last night's films by Criterion id, and by lbKey for entries from before the site's redesign,
// which keyed them by page slug. Either way a film already resolved keeps its Letterboxd URL.
async function loadPrevious() {
  let films = {};
  try {
    const res = await fetch(SNAPSHOT_URL, { headers: HEADERS });
    if (res.ok) films = (await res.json()).films || {};
  } catch {}
  const byKey = new Map(Object.values(films).map((film) => [lbKey(film), film]));
  return { size: Object.keys(films).length, get: (film) => films[film.id] || byKey.get(lbKey(film)) };
}

// Every film on the All Films page, from the JSON API behind it: id, title and year.
async function loadCatalog() {
  const films = new Map();
  for (let key = "1", pages = 0; key; pages++) {
    if (pages > 100) throw new Error("catalog paging never ended");
    const res = await criterionFetch(allFilmsUrl(key));
    if (!res.ok) throw new Error(`catalog responded ${res.status}`);
    const page = parseAllFilms(await res.json());
    for (const film of page.films) films.set(film.id, film);
    key = page.next;
  }
  return [...films.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// The catalog lists no directors, which matching leans on, so they come from each film's own record.
// That's one request a film, but only for films new to the snapshot: the rest keep last night's.
// The catalog's title is kept (the API's can be bare, e.g. an episode's "Episode 1"); its year too,
// unless it's unusable, when the film's own record usually has the right one.
async function withDirectors(film, id, previous) {
  // (Entries from the old site sometimes list a director twice.)
  if (previous?.directors && film.year && previous.year === film.year) return { ...film, directors: [...new Set(previous.directors)] };
  const res = await criterionFetch(mediaUrl(id));
  if (!res.ok) throw new Error(`Criterion responded ${res.status} for ${id}`);
  const meta = parseMedia(await res.json());
  return { ...film, year: film.year ?? meta?.year ?? null, directors: meta?.directors || [] };
}

async function main() {
  const all = await loadCatalog();
  if (all.length < 500) throw new Error(`catalog parsed to only ${all.length} films; API changed?`);
  const wanted = ONLY ? all.filter((f) => ONLY.has(f.id) || ONLY.has(slugify(f.title))) : all;
  const catalog = wanted.slice(0, LIMIT);
  const previous = await loadPrevious();
  console.log(`${catalog.length} films in catalog, ${previous.size} in previous snapshot`);

  const films = {};
  let done = 0;
  let errors = 0;
  let next = 0;
  const worker = async () => {
    while (next < catalog.length) {
      const { id, title, year } = catalog[next++];
      const listed = { title, year };
      const before = previous.get({ id, ...listed });
      try {
        const film = await withDirectors(listed, id, before);
        films[id] = { ...film, lb: await resolve(film, before) };
      } catch (err) {
        errors++;
        console.warn(`${id} (${listed.title}): ${err.message}`);
        // Keep last night's answer rather than dropping the film.
        if (before) films[id] = { ...listed, directors: before.directors || [], lb: before.lb };
      }
      if (++done % 250 === 0) console.log(`${done}/${catalog.length} (${errors} errors)`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (errors > catalog.length * MAX_ERROR_RATE) {
    throw new Error(`${errors} of ${catalog.length} lookups failed; not publishing`);
  }
  const matched = Object.values(films).filter((f) => f.lb).length;
  console.log(
    `matched ${matched}/${catalog.length}, ${errors} errors ` +
      `(${wikidataHits} matched via wikidata, ${wikidataErrors} wikidata failures)`
  );

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), films }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
