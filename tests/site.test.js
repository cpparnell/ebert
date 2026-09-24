const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cssModule,
  stateClass,
  criterionId,
  parseMedia,
  parseAllFilms,
  allFilmsUrl,
  mediaUrl,
  filmHref,
  formatRuntime,
} = require("../lib/site.js");

test("criterionId takes the media id from film and series links", () => {
  assert.equal(criterionId("/films/cWz0VOMv/boogie-nights"), "cWz0VOMv");
  assert.equal(criterionId("https://www.criterionchannel.com/series/V20hEnmd/les-miserables"), "V20hEnmd");
  assert.equal(criterionId("/films/cWz0VOMv"), "cWz0VOMv");
  assert.equal(criterionId("/films/cWz0VOMv/boogie-nights?play=1#x"), "cWz0VOMv");
});

test("criterionId ignores pages that aren't a film", () => {
  for (const href of [
    "/collections/N8akUcn7/starring-madonna",
    "/supplements/ETddh6cQ/southern-gothic-teaser",
    "/categories/QGtQj94z/popular-now",
    "/all-films",
    "/",
    "/films",
    "http://[bad",
  ]) {
    assert.equal(criterionId(href), null, href);
  }
});

test("parseMedia reads title, year and directors", () => {
  assert.deepEqual(
    parseMedia({ title: " Boogie Nights ", release_date: "1997-10-10", director: ["Paul Thomas Anderson"] }),
    { title: "Boogie Nights", year: 1997, directors: ["Paul Thomas Anderson"] }
  );
  assert.deepEqual(parseMedia({ title: "Co-directed", release_date: "1960-01-01", director: ["A", " B ", "", "A"] }).directors, [
    "A",
    "B",
  ]);
  // A bare string rather than a list.
  assert.deepEqual(parseMedia({ title: "X", release_date: "1950-01-01", director: "Someone" }).directors, ["Someone"]);
});

test("parseMedia gives an episode its full title, and otherwise ignores the original title", () => {
  const episode = { title: "Episode 1", title_original: "JOSÉPHINE EN TOURNÉE: Episode 1", release_date: "1990-01-01", director: ["Jacques Rozier"] };
  assert.equal(parseMedia(episode).title, "JOSÉPHINE EN TOURNÉE: Episode 1");
  const foreign = { title: "2 or 3 Things I Know About Her", title_original: "2 ou 3 choses que je sais d'elle", release_date: "1967-03-17", director: ["Jean-Luc Godard"] };
  assert.equal(parseMedia(foreign).title, "2 or 3 Things I Know About Her");
  assert.equal(parseMedia({ ...foreign, title_original: "" }).title, "2 or 3 Things I Know About Her");
});

test("parseMedia returns null without what matching needs", () => {
  assert.equal(parseMedia({ title: "Teaser", release_date: "2026-01-01", director: [] }), null);
  assert.equal(parseMedia({ title: "Undated", release_date: "", director: ["A"] }), null);
  assert.equal(parseMedia({ release_date: "1990-01-01", director: ["A"] }), null);
  assert.equal(parseMedia(null), null);
});

test("parseAllFilms keeps usable items and the next page's key", () => {
  const page = parseAllFilms({
    items: [
      { contentType: "film", duration: 5245, mediaid: "L5Z3RaiC", release_date: "1967-01-01", title: "2 or 3 Things I Know About Her" },
      { contentType: "series", duration: 0, mediaid: "cvCmhhxg", release_date: "1941-01-01", title: "The 47 Ronin" },
      { contentType: "series", duration: 0, mediaid: "fyMntgDP", release_date: "0-01-01", title: "Blossoms Shanghai" },
      { contentType: "film", release_date: "1990-01-01", title: "No id" },
    ],
    paging: { next_pagination_key: "2", page_limit: 200 },
    total: 3011,
  });
  assert.deepEqual(page.films, [
    { id: "L5Z3RaiC", title: "2 or 3 Things I Know About Her", year: 1967, type: "film", runtime: 87 },
    { id: "cvCmhhxg", title: "The 47 Ronin", year: 1941, type: "series", runtime: null },
    // Kept with no year: it's a real film Criterion misdates; its own record has the year.
    { id: "fyMntgDP", title: "Blossoms Shanghai", year: null, type: "series", runtime: null },
  ]);
  assert.equal(page.next, "2");
  assert.equal(page.total, 3011);
  assert.equal(parseAllFilms({ items: [], paging: {} }).next, null);
});

test("API urls", () => {
  assert.equal(mediaUrl("cWz0VOMv"), "https://www.criterionchannel.com/api/media/cWz0VOMv");
  assert.match(allFilmsUrl("3"), /\/api\/all-films\/results\?page_limit=\d+&pagination_key=3$/);
});

test("allFilmsUrl carries the page's own filters and sort, and sets its own paging", () => {
  const url = new URL(allFilmsUrl("2", "?genres=avant-garde&sort=year&sortDir=desc&decades=1950s%2C1960s&page_limit=60"));
  assert.equal(url.searchParams.get("genres"), "avant-garde");
  assert.equal(url.searchParams.get("decades"), "1950s,1960s");
  assert.equal(url.searchParams.get("sort"), "year");
  assert.equal(url.searchParams.get("sortDir"), "desc");
  assert.equal(url.searchParams.get("page_limit"), "200");
  assert.equal(url.searchParams.get("pagination_key"), "2");
});

test("filmHref links films and series by id", () => {
  assert.equal(filmHref({ id: "cWz0VOMv", type: "film" }), "/films/cWz0VOMv");
  assert.equal(filmHref({ id: "V20hEnmd", type: "series" }), "/series/V20hEnmd");
  assert.equal(criterionId(filmHref({ id: "abc123" })), "abc123");
});

test("formatRuntime matches the site's card format", () => {
  assert.equal(formatRuntime(87), "1 hr 27 min");
  assert.equal(formatRuntime(11), "11 min");
  assert.equal(formatRuntime(120), "2 hr");
  assert.equal(formatRuntime(null), "");
  assert.equal(formatRuntime(0), "");
});

test("stateClass derives the site's state class from an element's own", () => {
  const withClasses = (...names) => ({ classList: names });
  assert.equal(
    stateClass(withClasses("Accordion-module-less-module__abc123__title"), "accordionTitleOpen"),
    "Accordion-module-less-module__abc123__titleOpen"
  );
  assert.equal(
    stateClass(withClasses("x", "OptionButton-module-less-module__Q1__optionButton", "OptionButton-module-less-module__Q1__kindFilter"), "filterOptionActive"),
    "OptionButton-module-less-module__Q1__active"
  );
  assert.equal(stateClass(withClasses("unrelated"), "accordionIconOpen"), null);
});

test("cssModule anchors both ends of a hashed class name", () => {
  const sel = cssModule("Hero", "title");
  // Starts with the component, or follows a space; ends at the element, or before a space.
  assert.equal(
    sel,
    '[class^="Hero-module"][class$="__title"], [class^="Hero-module"][class*="__title "], ' +
      '[class*=" Hero-module"][class$="__title"], [class*=" Hero-module"][class*="__title "]'
  );
});
