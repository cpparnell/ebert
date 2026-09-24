const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFilmPage } = require("../lib/letterboxd.js");

const page = (extra, ld = "") => `
<html><head>
<meta property="og:title" content="Seven Samurai (1954)" />
<script type="application/ld+json">
/* <![CDATA[ */
{"name":"Seven Samurai","url":"https://letterboxd.com/film/seven-samurai/",
 "director":[{"name":"Akira Kurosawa"}],${ld}
 "aggregateRating":{"ratingValue":4.56,"ratingCount":412000}}
/* ]]> */
</script>
</head><body>${extra}</body></html>`;

test("parseFilmPage reads the runtime out of the page footer", () => {
  const film = parseFilmPage(page('<p class="text-link text-footer"> 207&nbsp;mins &nbsp; More at <a>IMDb</a></p>'));
  assert.equal(film.runtime, 207);
  assert.equal(film.name, "Seven Samurai");
  assert.equal(film.year, 1954);
  assert.equal(film.rating, 4.56);
});

test("parseFilmPage handles a runtime with a thousands separator, and one that isn't there", () => {
  assert.equal(parseFilmPage(page("<p>1,440&nbsp;mins</p>")).runtime, 1440);
  assert.equal(parseFilmPage(page("")).runtime, null);
});

// The taste model's features (lib/taste.js). Both are in the JSON-LD the page already parses, so
// they cost no extra request — but `countryOfOrigin` nests its names and `genre` doesn't.
test("parseFilmPage reads genres and countries out of the JSON-LD", () => {
  const ld = `"genre":["Drama","Action"],"countryOfOrigin":[{"@type":"Country","name":"Japan"}],`;
  const film = parseFilmPage(page("", ld));
  assert.deepEqual(film.genres, ["Drama", "Action"]);
  assert.deepEqual(film.countries, ["Japan"]);
});

test("parseFilmPage reports no genres or countries rather than undefined", () => {
  const film = parseFilmPage(page(""));
  assert.deepEqual(film.genres, []);
  assert.deepEqual(film.countries, []);
});
