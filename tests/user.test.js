const test = require("node:test");
const assert = require("node:assert/strict");
const {
  UserNotFound,
  normalizeUsername,
  lbSlug,
  parsePosterPage,
  fetchUserFilms,
  needsSync,
  userMark,
  starText,
  describeSync,
} = require("../lib/user.js");

// Trimmed from a real /<user>/films/ page.
const poster = (slug, rated) => `
  <li class="griditem">
    <div class="react-component" data-component-class="LazyPoster" data-item-name="X" data-item-slug="${slug}" data-item-link="/film/${slug}/">
      <div class="poster film-poster"><img class="image" alt="X"/></div>
    </div>
    ${rated ? `<p class="poster-viewingdata" data-item-uid="film:1"> <span class="rating -micro -darker rated-${rated}">★</span> </p>` : ""}
  </li>`;
const page = (items, next) =>
  `<div class="poster-grid"><ul class="grid -p70">${items.join("")}</ul></div>
   <div class="pagination"><div class="paginate-nextprev paginate-disabled"><span class="previous">Newer</span></div>
   ${next ? `<div class="paginate-nextprev"><a class="next" href="${next}">Older</a></div>` : ""}</div>`;

const res = (status, body = "") => ({ status, ok: status >= 200 && status < 300, text: async () => body });

test("normalizeUsername accepts names, handles and profile URLs", () => {
  assert.equal(normalizeUsername("Schaffrillas"), "schaffrillas");
  assert.equal(normalizeUsername("  @dave_h "), "dave_h");
  assert.equal(normalizeUsername("https://letterboxd.com/DaveH/films/"), "daveh");
  assert.equal(normalizeUsername("letterboxd.com/dave"), "dave");
  assert.equal(normalizeUsername(""), null);
  assert.equal(normalizeUsername("not a name"), null);
  assert.equal(normalizeUsername("a"), null);
});

test("lbSlug extracts the film slug from a Letterboxd URL", () => {
  assert.equal(lbSlug("https://letterboxd.com/film/seven-samurai/"), "seven-samurai");
  assert.equal(lbSlug("https://letterboxd.com/film/her-2013/?x=1"), "her-2013");
  assert.equal(lbSlug("https://letterboxd.com/dave/"), null);
  assert.equal(lbSlug(undefined), null);
});

test("parsePosterPage reads slugs, half-star ratings and pagination", () => {
  const html = page([poster("seven-samurai", 10), poster("ran", 7), poster("ikiru")], "/u/films/page/2/");
  assert.deepEqual(parsePosterPage(html), {
    films: [
      { slug: "seven-samurai", rating: 5 },
      { slug: "ran", rating: 3.5 },
      { slug: "ikiru", rating: 0 },
    ],
    hasNext: true,
  });
  assert.equal(parsePosterPage(page([poster("ran")])).hasNext, false);
  assert.deepEqual(parsePosterPage("<html>nothing</html>"), { films: [], hasNext: false });
});

test("fetchUserFilms walks every page of films and watchlist", async () => {
  const pages = {
    "https://letterboxd.com/dave/films/": page([poster("ran", 8)], "/dave/films/page/2/"),
    "https://letterboxd.com/dave/films/page/2/": page([poster("ikiru")]),
    "https://letterboxd.com/dave/watchlist/": page([poster("harakiri")], "/dave/watchlist/page/2/"),
    "https://letterboxd.com/dave/watchlist/page/2/": page([poster("kwaidan")]),
  };
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return url in pages ? res(200, pages[url]) : res(404);
  };
  const user = await fetchUserFilms("dave", fetchImpl);
  assert.equal(user.username, "dave");
  assert.deepEqual(user.watched, { ran: 4, ikiru: 0 });
  assert.deepEqual(user.watchlist, { harakiri: 1, kwaidan: 1 });
  assert.equal(typeof user.syncedAt, "number");
  assert.equal(requested.length, 4);
});

test("fetchUserFilms reports unknown members and other failures", async () => {
  await assert.rejects(fetchUserFilms("nobody", async () => res(404)), UserNotFound);
  await assert.rejects(fetchUserFilms("dave", async () => res(403)), (err) => !(err instanceof UserNotFound));
});

test("fetchUserFilms stops on an empty page even if it links onward", async () => {
  let calls = 0;
  const user = await fetchUserFilms("dave", async () => (calls++, res(200, page([], "/next/"))));
  assert.deepEqual(user.watched, {});
  assert.equal(calls, 2);
});

test("userMark reports watched (with rating), watchlist, or nothing", () => {
  const user = { watched: { ran: 4.5, ikiru: 0 }, watchlist: { harakiri: 1, ran: 1 } };
  const film = (slug) => ({ url: `https://letterboxd.com/film/${slug}/` });
  assert.deepEqual(userMark(film("ran"), user), { watched: true, rating: 4.5, watchlist: false });
  assert.deepEqual(userMark(film("ikiru"), user), { watched: true, rating: null, watchlist: false });
  assert.deepEqual(userMark(film("harakiri"), user), { watched: false, rating: null, watchlist: true });
  assert.equal(userMark(film("kwaidan"), user), null);
  assert.equal(userMark(film("ran"), null), null);
  assert.equal(userMark({ url: null }, user), null);
});

test("starText renders whole and half stars", () => {
  assert.equal(starText(5), "★★★★★");
  assert.equal(starText(3.5), "★★★½");
  assert.equal(starText(0.5), "½");
});

test("describeSync explains each sync state", () => {
  const now = 1_000_000_000;
  const min = 60_000;
  assert.equal(describeSync(null, now), "");
  assert.equal(describeSync({ state: "syncing", username: "dave", at: now - min }, now), "Syncing dave…");
  assert.equal(describeSync({ state: "syncing", username: "dave", at: now - 10 * min }, now), "The last sync didn't finish.");
  assert.equal(
    describeSync({ state: "ok", username: "dave", at: now - 5 * min, watched: 1234, watchlist: 56 }, now),
    "1,234 watched · 56 in watchlist · synced 5 min ago"
  );
  assert.match(describeSync({ state: "ok", at: now - 10_000, watched: 1, watchlist: 0 }, now), /synced just now$/);
  assert.match(describeSync({ state: "ok", at: now - 180 * min, watched: 1, watchlist: 0 }, now), /synced 3 h ago$/);
  assert.equal(describeSync({ state: "not-found", username: "zz" }, now), 'No Letterboxd member named "zz".');
  assert.match(describeSync({ state: "error", message: "403" }, now), /Couldn't reach Letterboxd/);
});

test("needsSync re-reads a profile once the last attempt is maxAge old", () => {
  const now = 1_000_000_000;
  const user = { username: "dave", syncedAt: now - 30_000 };
  const check = (opts) => needsSync({ user, username: "dave", maxAge: 60_000, now, ...opts });
  assert.equal(check({}), false); // synced 30s ago
  assert.equal(check({ now: now + 30_000 }), true); // now 60s old
  assert.equal(check({ force: true }), true);
  assert.equal(check({ username: "anna" }), true); // data is someone else's
  assert.equal(check({ user: null }), true); // never synced
  assert.equal(check({ username: null }), false); // no username set
});

test("needsSync doesn't retry a recent failed or in-flight attempt on every page load", () => {
  const now = 1_000_000_000;
  const user = { username: "dave", syncedAt: now - 3_600_000 };
  const check = (status) => needsSync({ user, status, username: "dave", maxAge: 60_000, now });
  assert.equal(check({ state: "error", username: "dave", at: now - 10_000 }), false);
  assert.equal(check({ state: "syncing", username: "dave", at: now - 10_000 }), false);
  assert.equal(check({ state: "error", username: "dave", at: now - 120_000 }), true);
  assert.equal(check({ state: "error", username: "anna", at: now - 10_000 }), true); // another user's attempt
  assert.equal(check(undefined), true);
});
