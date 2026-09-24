// The user's own Letterboxd activity, read from their public profile pages (no login needed):
// every film they've watched, with their rating, and their watchlist. Synced by the background
// worker; cards are marked by comparing a result's Letterboxd URL against it.
// Shape: { username, syncedAt, watched: { [lbSlug]: rating 0.5–5 | 0 (unrated) }, watchlist: { [lbSlug]: 1 } }
const USERNAME_KEY = "user:name";
const USER_KEY = "user";
const USER_STATUS_KEY = "user:status";
const USER_ORIGIN = "https://letterboxd.com";
const USER_REFRESH_MS = 60 * 1000; // page loads re-sync at most this often
const USER_MAX_PAGES = 300; // 72 films a page: far past any real diary, just a runaway guard

class UserNotFound extends Error {}

// Accepts "name", "@name" or a profile URL; Letterboxd usernames are letters, digits and underscores.
function normalizeUsername(input) {
  const s = String(input || "").trim();
  const fromUrl = s.match(/letterboxd\.com\/([^/?#\s]+)/i)?.[1];
  const name = (fromUrl || s).replace(/^@/, "");
  return /^[A-Za-z0-9_]{2,}$/.test(name) ? name.toLowerCase() : null;
}

// "https://letterboxd.com/film/seven-samurai/" -> "seven-samurai"
function lbSlug(url) {
  return String(url || "").match(/\/film\/([^/?#]+)/)?.[1] || null;
}

// One page of a poster grid (/<user>/films/, /<user>/watchlist/). The owner's rating is a
// "rated-N" class in half-stars next to each poster; the watchlist has none.
function parsePosterPage(html) {
  const films = [];
  for (const item of html.split(/<li class="griditem/).slice(1)) {
    const slug = item.match(/data-item-slug="([^"]+)"/)?.[1];
    if (!slug) continue;
    const halves = +item.match(/\brated-(\d+)\b/)?.[1] || 0;
    films.push({ slug, rating: halves / 2 });
  }
  return { films, hasNext: /<a class="next" href=/.test(html) };
}

async function fetchPosterGrid(username, list, fetchImpl) {
  const films = [];
  for (let page = 1; page <= USER_MAX_PAGES; page++) {
    const url = `${USER_ORIGIN}/${username}/${list}/${page > 1 ? `page/${page}/` : ""}`;
    const res = await fetchImpl(url);
    if (res.status === 404 && page === 1) throw new UserNotFound(`No Letterboxd member "${username}"`);
    if (!res.ok) throw new Error(`Letterboxd responded ${res.status} for ${url}`);
    const { films: found, hasNext } = parsePosterPage(await res.text());
    films.push(...found);
    if (!hasNext || !found.length) break;
  }
  return films;
}

async function fetchUserFilms(username, fetchImpl = fetch) {
  const watched = {};
  for (const { slug, rating } of await fetchPosterGrid(username, "films", fetchImpl)) watched[slug] = rating;
  const watchlist = {};
  for (const { slug } of await fetchPosterGrid(username, "watchlist", fetchImpl)) watchlist[slug] = 1;
  return { username, syncedAt: Date.now(), watched, watchlist };
}

// Whether to re-read `username`'s profile: always when forced or when `user` (the last synced data)
// is someone else's, otherwise once the last attempt (`status`, successful or not) is maxAge old,
// so a failing sync isn't retried on every page load.
function needsSync({ user, status, username, force = false, maxAge, now = Date.now() }) {
  if (!username) return false;
  if (force || user?.username !== username) return true;
  const last = Math.max(user.syncedAt || 0, status?.username === username ? status.at || 0 : 0);
  return now - last >= maxAge;
}

// What the user has done with a matched film: { watched, rating, watchlist }, or null for nothing.
function userMark(film, user) {
  const slug = lbSlug(film?.url);
  if (!slug || !user) return null;
  if (slug in (user.watched || {})) return { watched: true, rating: user.watched[slug] || null, watchlist: false };
  if (user.watchlist?.[slug]) return { watched: false, rating: null, watchlist: true };
  return null;
}

// 3.5 -> "★★★½"
const starText = (rating) => "★".repeat(Math.floor(rating)) + (rating % 1 ? "½" : "");

const USER_SYNC_STUCK_MS = 5 * 60 * 1000; // a worker killed mid-sync leaves "syncing" behind

function ago(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// The popup's one-line account of the last sync (USER_STATUS_KEY), or "" before any.
function describeSync(status, now = Date.now()) {
  if (!status) return "";
  const n = (x) => new Intl.NumberFormat("en-US").format(x);
  switch (status.state) {
    case "syncing":
      return now - status.at > USER_SYNC_STUCK_MS ? "The last sync didn't finish." : `Syncing ${status.username}…`;
    case "ok":
      return `${n(status.watched)} watched · ${n(status.watchlist)} in watchlist · synced ${ago(now - status.at)}`;
    case "not-found":
      return `No Letterboxd member named "${status.username}".`;
    default:
      return "Couldn't reach Letterboxd. It'll retry within the hour.";
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    USERNAME_KEY,
    USER_KEY,
    USER_STATUS_KEY,
    USER_REFRESH_MS,
    UserNotFound,
    normalizeUsername,
    lbSlug,
    parsePosterPage,
    fetchUserFilms,
    needsSync,
    userMark,
    starText,
    describeSync,
  };
}
