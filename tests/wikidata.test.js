const test = require("node:test");
const assert = require("node:assert/strict");
const { claim, years, filmIds, letterboxdUrls, rankCandidates, acceptsFilm } = require("../scripts/wikidata.js");
const { isSearchMatch } = require("../lib/letterboxd.js");

const snak = (value) => ({ mainsnak: { datavalue: { value } } });
const entity = (props) => Object.fromEntries(Object.entries(props).map(([p, vs]) => [p, vs.map(snak)]));

test("claim flattens snak values and skips somevalue/novalue", () => {
  const claims = { P345: [snak("tt0064816"), { mainsnak: { snaktype: "somevalue" } }] };
  assert.deepEqual(claim(claims, "P345"), ["tt0064816"]);
  assert.deepEqual(claim(claims, "P999"), []);
  assert.deepEqual(claim(undefined, "P345"), []);
});

test("years reads every publication date, ignoring malformed ones", () => {
  const claims = entity({
    P577: [{ time: "+1969-01-31T00:00:00Z" }, { time: "+1970-03-01T00:00:00Z" }, { time: null }],
  });
  assert.deepEqual(years(claims), [1969, 1970]);
  assert.deepEqual(years(entity({})), []);
});

test("filmIds keeps only items that can name a Letterboxd film", () => {
  assert.deepEqual(filmIds(entity({ P6127: ["the-swimming-pool"], P4947: ["4946"], P345: ["tt0064816"] })), {
    letterboxd: "the-swimming-pool",
    tmdb: "4946",
    imdb: "tt0064816",
  });
  // A museum or a painting that shares the title carries none of the three.
  assert.equal(filmIds(entity({ P31: [{ id: "Q207694" }] })), null);
  // An IMDb id that isn't a title id (a person, "nm…") is not a film.
  assert.equal(filmIds(entity({ P345: ["nm0000123"] })), null);
  assert.deepEqual(filmIds(entity({ P4947: ["4946"] })), { letterboxd: null, tmdb: "4946", imdb: null });
});

test("letterboxdUrls tries the recorded slug before the id redirects", () => {
  assert.deepEqual(letterboxdUrls({ letterboxd: "metisse", tmdb: "41402", imdb: "tt0107574" }), [
    "https://letterboxd.com/film/metisse/",
    "https://letterboxd.com/tmdb/41402/",
    "https://letterboxd.com/imdb/tt0107574/",
  ]);
  assert.deepEqual(letterboxdUrls({ letterboxd: null, tmdb: null, imdb: "tt0107574" }), [
    "https://letterboxd.com/imdb/tt0107574/",
  ]);
  assert.deepEqual(letterboxdUrls({ letterboxd: null, tmdb: null, imdb: null }), []);
});

const candidate = (id, ys, directors) => ({ id, ids: { letterboxd: id }, years: ys, directors });

test("rankCandidates drops candidates that agree on neither year nor director", () => {
  const film = { title: "Bluebeard", year: 1938, directors: ["Jean Painlevé"] };
  const ranked = rankCandidates(
    [
      candidate("Q1", [1972], ["Edward Dmytryk"]), // different film of the same name
      candidate("Q2", [1938], ["Jean Painlevé"]),
    ],
    film
  );
  assert.deepEqual(ranked.map((c) => c.id), ["Q2"]);
});

test("rankCandidates tries a director match before a year-only coincidence", () => {
  const film = { title: "Assassin", year: 1964, directors: ["Kon Ichikawa"] };
  const ranked = rankCandidates(
    [
      candidate("Q-year", [1965], ["Someone Else"]),
      candidate("Q-director", [1990], ["Kon Ichikawa"]),
    ],
    film
  );
  assert.deepEqual(ranked.map((c) => c.id), ["Q-director", "Q-year"]);
});

test("rankCandidates accepts a year within one, and compares directors loosely", () => {
  const film = { title: "Coach to Vienna", year: 1966, directors: ["Karel Kachyňa"] };
  assert.equal(rankCandidates([candidate("Q1", [1967], [])], film).length, 1);
  assert.equal(rankCandidates([candidate("Q1", [1968], [])], film).length, 0);
  // Accents and case differ between Criterion and Wikidata; squash folds both.
  assert.equal(rankCandidates([candidate("Q1", [], ["Karel Kachyna"])], film).length, 1);
});

test("rankCandidates falls back to directors when Criterion has no year", () => {
  const film = { title: "Aletheia", directors: ["Ernie Gehr"] };
  assert.equal(rankCandidates([candidate("Q1", [1992], [])], film).length, 0);
  assert.equal(rankCandidates([candidate("Q1", [1992], ["Ernie Gehr"])], film).length, 1);
});

const page = (name, year, directors) => ({ name, year, directors });

test("acceptsFilm needs two of director, title and year to agree", () => {
  const film = { title: "La piscine", year: 1969, directors: ["Jacques Deray"] };
  // The whole point of the Wikidata route: the title differs, so year and director carry it.
  assert.ok(acceptsFilm(page("The Swimming Pool", 1969, ["Jacques Deray"]), film, "La piscine", false));
  // Same director, different film and year: one signal isn't enough.
  assert.ok(!acceptsFilm(page("The Outside Man", 1972, ["Jacques Deray"]), film, "La piscine", false));
  // Year alone isn't either — plenty of 1969 films aren't this one.
  assert.ok(!acceptsFilm(page("Z", 1969, ["Costa-Gavras"]), film, "La piscine", false));
});

test("acceptsFilm requires the parent title itself to match for an installment", () => {
  const gits = { title: "GHOST IN THE SHELL: STAND ALONE COMPLEX: Episode 15", year: 2005, directors: ["Kenji Kamiyama"] };
  const parent = "GHOST IN THE SHELL: STAND ALONE COMPLEX";
  const sss = page("Ghost in the Shell: Stand Alone Complex - Solid State Society", 2006, ["Kenji Kamiyama"]);
  // Director and year agree across the whole franchise, so they clear isSearchMatch on their own...
  assert.ok(isSearchMatch(sss, gits, parent));
  // ...but Solid State Society is a different work, and the parent-title rule catches that.
  assert.ok(!acceptsFilm(sss, gits, parent, true));

  const prisoner = { title: "THE PRISONER: Episode 1", year: 1867, directors: ["Patrick McGoohan"] };
  assert.ok(acceptsFilm(page("The Prisoner", 1967, ["Patrick McGoohan"]), prisoner, "THE PRISONER", true));
});
