const LB_ORIGIN = "https://letterboxd.com";

// Mirrors Letterboxd's slug scheme: accents folded, apostrophes and "&" dropped, other punctuation -> "-".
function slugify(s) {
  return s
    .replace(/½/g, " half ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’‘`&]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const squash = (s) => slugify(s).replace(/-/g, "");

// Shared by background (writes) and content (first-paint reads) so both agree on the cache key.
const lbKey = (film) => `lb:${squash(film.title)}|${film.year ?? ""}`;

function candidateSlugs(title, year) {
  const base = slugify(title);
  const noArticle = slugify(title.replace(/^(the|a|an)\s+/i, ""));
  const out = [base];
  if (year) out.push(`${base}-${year}`);
  if (noArticle !== base) {
    out.push(noArticle);
    if (year) out.push(`${noArticle}-${year}`);
  }
  if (year) out.push(`${base}-${year - 1}`, `${base}-${year + 1}`);
  return [...new Set(out)].filter(Boolean);
}

function parseFilmPage(html) {
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!ld) return null;
  let data;
  try {
    data = JSON.parse(ld[1].replace(/\/\*[\s\S]*?\*\//g, "").trim());
  } catch {
    return null;
  }
  const ogYear = html.match(/<meta property="og:title" content="[^"]*\((\d{4})\)"/);
  const year = ogYear ? +ogYear[1] : data.dateCreated ? +data.dateCreated.slice(0, 4) : null;
  return {
    name: data.name,
    year,
    directors: (data.director || []).map((d) => d.name),
    url: data.url,
    rating: data.aggregateRating?.ratingValue ?? null,
    ratingCount: data.aggregateRating?.ratingCount ?? 0,
  };
}

const directorMatch = (a, b = []) => {
  const set = new Set(a.map(squash));
  return b.some((d) => set.has(squash(d)));
};

const yearNear = (a, b) => a && b && Math.abs(a - b) <= 1;

// The slug already encodes the title, so a director or near-year match is enough to confirm identity.
function isMatch(film, { year, directors = [] }) {
  if (directorMatch(film.directors, directors)) return true;
  if (yearNear(film.year, year)) return true;
  return !year && !directors.length;
}

// Search results are fuzzy and a director has many films, so any two of director, title and
// year must agree. Title alone differs for translated titles ("Les créatures" -> "The Creatures").
function isSearchMatch(film, query, title) {
  const signals = [
    directorMatch(film.directors, query.directors),
    squash(film.name) === squash(title),
    yearNear(film.year, query.year),
  ];
  return signals.filter(Boolean).length >= 2;
}

const VERSION_SUFFIX = /\s*(?:\([^)]*\bversion\)|:[^:]*\bversion(?:\s+\d+)?)\s*$/i;
const PART_SUFFIX = /:\s*(?:episodes?|parts?|chapter|volume|vol\.)\s.*$/i;

async function fetchFilm(slug, fetchImpl) {
  const res = await fetchImpl(`${LB_ORIGIN}/film/${slug}/`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Letterboxd responded ${res.status} for ${slug}`);
  return parseFilmPage(await res.text());
}

// Letterboxd's own autocomplete. Cloudflare challenges it for non-browser clients (it needs the
// user's cookies), so it's only the fallback for titles the slug guesses can't reach.
async function searchFilms(q, fetchImpl) {
  const res = await fetchImpl(`${LB_ORIGIN}/s/autocompletefilm?q=${encodeURIComponent(q)}&limit=8`, {
    credentials: "include",
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null);
  return (body?.data || [])
    .filter((d) => d.type === "film" && d.slug)
    .map((d) => ({
      slug: d.slug,
      name: d.name,
      year: d.releaseYear,
      directors: (d.directors || []).map((x) => x.name),
    }));
}

async function resolveFilm(query, fetchImpl = fetch) {
  const title = query.title.replace(VERSION_SUFFIX, "").trim() || query.title;
  for (const slug of candidateSlugs(title, query.year)) {
    const film = await fetchFilm(slug, fetchImpl);
    if (film && isMatch(film, query)) return film;
  }
  // "Carlos: Part 2" or "FANNY AND ALEXANDER: Episode 3" is scored as the whole work.
  const parent = title.replace(PART_SUFFIX, "").trim();
  for (const t of new Set([title, parent])) {
    const hit = (await searchFilms(t, fetchImpl)).find((c) => isSearchMatch(c, query, t));
    if (hit) return fetchFilm(hit.slug, fetchImpl);
  }
  return null;
}

if (typeof module !== "undefined") {
  module.exports = { slugify, squash, lbKey, candidateSlugs, parseFilmPage, isMatch, isSearchMatch, searchFilms, resolveFilm };
}
