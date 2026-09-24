// Build-only (see CLAUDE.md): the nightly Action's replacement for Letterboxd search.
//
// Cloudflare answers 403 to /s/autocompletefilm and /search/films/ for any non-browser client, so
// the Action can only reach Letterboxd by guessing slugs — which fails for every film Criterion
// lists under a title Letterboxd doesn't use ("La piscine" lives at /film/the-swimming-pool/, and
// /film/la-piscine/ is a different film entirely). Wikidata is keyless, unblocked, and records the
// Letterboxd slug itself (P6127) alongside TMDB (P4947) and IMDb (P345) ids, both of which
// Letterboxd resolves via /tmdb/<id>/ and /imdb/<id>/ redirects.
//
// Wikidata only ever *proposes* a film; every candidate is confirmed by fetching the Letterboxd
// page and checking it against Criterion's own metadata, so a wrong proposal is rejected. That
// check is `isSearchMatch` (two of director, title and year), not the looser `isMatch` the slug
// guesses use: a slug already encodes the title, so a director match alone confirms it there,
// whereas a Wikidata label match is as fuzzy as a search hit. Director alone is not enough —
// it matched every "GHOST IN THE SHELL: STAND ALONE COMPLEX" episode to Kamiyama's unrelated
// "Solid State Society". Node-only: no chrome.* and no DOM, but nothing here is loaded by the
// extension, which has the user's cookies and so uses search instead.
const { parseFilmPage, isSearchMatch, squash, titleVariants } = require("../lib/letterboxd.js");

const WD_API = "https://www.wikidata.org/w/api.php";
const LB_ORIGIN = "https://letterboxd.com";
// Enough to reach past the museums, lakes and paintings that share a film's name, without paying
// for a long tail we'd never fetch: only candidates carrying a film id survive the next step.
const SEARCH_LIMIT = 20;
// Letterboxd pages are the expensive part, so only the best few candidates are ever fetched.
const MAX_CANDIDATES = 3;

const first = (xs) => (xs.length ? xs[0] : null);

// Claim values, flattened past Wikidata's snak wrapper. Somevalue/novalue snaks have no
// `datavalue` at all, hence the filter.
const claim = (claims, prop) =>
  (claims?.[prop] || []).map((c) => c.mainsnak?.datavalue?.value).filter((v) => v != null);

// P577 (publication date) is a time snak like "+1969-01-01T00:00:00Z", and a film often carries
// several — one per country's release — so every year is kept as an acceptable match.
const years = (claims) =>
  claim(claims, "P577")
    .map((v) => (typeof v?.time === "string" ? +v.time.slice(1, 5) : null))
    .filter(Boolean);

// A Wikidata item is only worth fetching if it can name a Letterboxd film. Items without any of
// the three ids are the museums and paintings the search turned up.
function filmIds(claims) {
  const ids = {
    letterboxd: first(claim(claims, "P6127").filter((v) => typeof v === "string")),
    tmdb: first(claim(claims, "P4947").filter((v) => typeof v === "string")),
    imdb: first(claim(claims, "P345").filter((v) => /^tt\d+$/.test(v))),
  };
  return ids.letterboxd || ids.tmdb || ids.imdb ? ids : null;
}

// The pages to try for one candidate, best first: the recorded slug, then the two redirects.
// P6127 is the direct answer when it's there; the id redirects cover items nobody has linked to
// Letterboxd yet, which is most of them.
function letterboxdUrls({ letterboxd, tmdb, imdb }) {
  return [
    letterboxd && `${LB_ORIGIN}/film/${letterboxd}/`,
    tmdb && `${LB_ORIGIN}/tmdb/${tmdb}/`,
    imdb && `${LB_ORIGIN}/imdb/${imdb}/`,
  ].filter(Boolean);
}

// Wikidata search is fuzzy and a title like "Bluebeard" or "Assassin" belongs to many films, so a
// candidate has to agree with Criterion on the year or the director before we spend a request on
// it. `acceptsFilm` still has the final say; this only decides what's worth fetching.
// Ranked so a director match — the stronger signal — is tried ahead of a year-only coincidence.
function rankCandidates(candidates, film) {
  const directors = new Set((film.directors || []).map(squash));
  return candidates
    .map((c) => {
      const byDirector = c.directors.some((d) => directors.has(squash(d)));
      const byYear = film.year ? c.years.some((y) => Math.abs(y - film.year) <= 1) : false;
      return { candidate: c, score: (byDirector ? 2 : 0) + (byYear ? 1 : 0) };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((c) => c.candidate);
}

// ---------- network ----------

const json = async (url, fetchImpl) => {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Wikidata responded ${res.status}`);
  return res.json();
};

// Labels for the director items a title's candidates point at, fetched in one call for the lot
// rather than one per candidate. Wikidata caps a request at 50 ids; a title with many candidates,
// each with several directors, can pass that, so this pages rather than dropping the remainder —
// a director whose name never arrived would silently weaken `rankCandidates`.
const WD_MAX_IDS = 50;

async function directorNames(ids, fetchImpl) {
  const names = {};
  for (let i = 0; i < ids.length; i += WD_MAX_IDS) {
    const batch = ids.slice(i, i + WD_MAX_IDS);
    const body = await json(
      `${WD_API}?action=wbgetentities&format=json&props=labels&languages=en&ids=${batch.join("|")}`,
      fetchImpl
    );
    for (const [id, entity] of Object.entries(body.entities || {})) {
      const label = entity?.labels?.en?.value;
      if (label) names[id] = label;
    }
  }
  return names;
}

// Everything Wikidata knows about one title: the items whose label or alias matches, reduced to
// those that can name a film, with their years and director names attached.
async function searchCandidates(title, fetchImpl) {
  const search = `${WD_API}?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=${SEARCH_LIMIT}&search=${encodeURIComponent(title)}`;
  const found = await json(search, fetchImpl);
  const ids = (found.search || []).map((x) => x.id).filter(Boolean);
  if (!ids.length) return [];

  // SEARCH_LIMIT is well under WD_MAX_IDS, so the claims for a whole search fit in one call.
  const entities = await json(
    `${WD_API}?action=wbgetentities&format=json&props=claims&ids=${ids.slice(0, WD_MAX_IDS).join("|")}`,
    fetchImpl
  );

  // `ids` order is Wikidata's relevance ranking; keep it.
  const candidates = [];
  const directorIds = new Set();
  for (const id of ids) {
    const claims = entities.entities?.[id]?.claims;
    const ids_ = claims && filmIds(claims);
    if (!ids_) continue;
    const directors = claim(claims, "P57")
      .map((v) => v?.id)
      .filter(Boolean);
    directors.forEach((d) => directorIds.add(d));
    candidates.push({ id, ids: ids_, years: years(claims), directorIds: directors });
  }

  const names = await directorNames([...directorIds], fetchImpl);
  return candidates.map((c) => ({ ...c, directors: c.directorIds.map((d) => names[d]).filter(Boolean) }));
}

// Whether a fetched Letterboxd page really is this Criterion film.
//
// For the film's own title, two of director, title and year agreeing is the bar (`isSearchMatch`).
// For a parent title — the whole work an installment belongs to — that bar is meaningless, because
// every entry in a franchise shares its director and its years: "GHOST IN THE SHELL: STAND ALONE
// COMPLEX: Episode 15" cleared it against Kamiyama's separate "Solid State Society" film. So the
// installment path additionally demands the titles actually be the same work, which is what
// "THE PRISONER: Episode 1" -> "The Prisoner" is and Solid State Society isn't.
function acceptsFilm(found, film, title, isParentTitle) {
  if (!isSearchMatch(found, film, title)) return false;
  return !isParentTitle || squash(found.name) === squash(title);
}

// Resolves one Criterion film through Wikidata, or null. `wdFetch` talks to Wikidata and
// `lbFetch` to Letterboxd, so the caller keeps each behind its own rate limit.
//
// Installments are handled the way `resolveFilm` handles them: the episode's own title first, then
// the whole work's, with `series` set when the rating that comes back is the work's, not the
// episode's ("AGNÈS DE CI DE LÀ VARDA: Episode 1" is only on Wikidata as the series).
async function resolveViaWikidata(film, wdFetch, lbFetch) {
  const titles = titleVariants(film.title);
  for (const title of titles) {
    const isParentTitle = title !== titles[0];
    const candidates = rankCandidates(await searchCandidates(title, wdFetch), film);
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      for (const url of letterboxdUrls(candidate.ids)) {
        const res = await lbFetch(url);
        if (res.status === 404) continue;
        if (!res.ok) throw new Error(`Letterboxd responded ${res.status} for ${url}`);
        const found = parseFilmPage(await res.text());
        if (found && acceptsFilm(found, film, title, isParentTitle)) {
          return isParentTitle ? { ...found, series: true } : found;
        }
      }
    }
  }
  return null;
}

module.exports = { claim, years, filmIds, letterboxdUrls, rankCandidates, acceptsFilm, searchCandidates, resolveViaWikidata, WD_API };
