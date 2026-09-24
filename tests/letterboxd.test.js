const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFilmPage } = require("../lib/letterboxd.js");

const page = (extra) => `
<html><head>
<meta property="og:title" content="Seven Samurai (1954)" />
<script type="application/ld+json">
/* <![CDATA[ */
{"name":"Seven Samurai","url":"https://letterboxd.com/film/seven-samurai/",
 "director":[{"name":"Akira Kurosawa"}],
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
