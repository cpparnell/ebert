// Everything that depends on how www.criterionchannel.com is built: its URLs, the JSON API behind
// it, and the selectors for the markup we read and draw into. When the site changes, this is the
// file to update — nothing else should name a Criterion class, path or endpoint.
//
// Runs in the content script, and in Node for scripts/build-snapshot.js, so it never reaches for
// `document`; stateClass only reads the element it's handed.

const SITE_ORIGIN = "https://www.criterionchannel.com";

// The site is Next.js with CSS modules, so a class reads "PlaylistCard-module-less-module__Xfr99W__card":
// the hash in the middle changes whenever they redeploy, the component and element names around it
// don't. This matches on those two. It's anchored at both ends of the class name, so "__title"
// doesn't also catch "__titleRow", nor "Hero" catch "EntityHero".
function cssModule(component, element) {
  const starts = [`[class^="${component}-module"]`, `[class*=" ${component}-module"]`];
  const ends = [`[class$="__${element}"]`, `[class*="__${element} "]`];
  return starts.flatMap((start) => ends.map((end) => start + end)).join(", ");
}

const SELECTORS = {
  // A poster card, on browse rails, collections, search and All Films alike.
  card: cssModule("PlaylistCard", "card"),
  // The card's link to its film. Collections and supplements use the same card, and are skipped for
  // not linking to a film (see criterionId).
  cardLink: 'a[href*="/films/"], a[href*="/series/"]',
  // The artwork, which the badge is drawn over.
  cardImage: cssModule("PlaylistCard", "imageWrapper"),
  cardTitle: cssModule("PlaylistCard", "title"),
  // "1991" on a film's card; the same slot holds "12 Films" on a collection's.
  cardYear: cssModule("PlaylistCard", "metaLeft"),
  cardRuntime: cssModule("PlaylistCard", "metaRight"),
  // Parts of a card that only work with the site's own handlers, removed from our copies of it.
  cardInert: `${cssModule("PlaylistCard", "moreButton")}, ${cssModule("PlaylistCard", "progressBar")}`,
  // A film page's header: the title, then a row of year and runtime. The Letterboxd line goes
  // under the row, or under the title if the row is missing.
  detailTitle: cssModule("Hero", "title"),
  detailMeta: cssModule("Hero", "metaRow"),
  // Present once React has hydrated the server-rendered page, and not before: Next.js's app router
  // adds it from an effect. Nothing may be drawn into the page until then (see content.js).
  hydrated: "next-route-announcer",

  // All Films (ALL_FILMS_PATH): the grid of results, the element it loads more through, and the
  // filter panel beside it — a column of accordions under a "Filters" label, which ours joins.
  allFilmsGrid: cssModule("page", "allFilmsGrid"),
  allFilmsLoader: cssModule("page", "loadMoreSentinel"),
  filterPanel: cssModule("AllFilmsFiltersPanel", "panel"),
  filterSectionLabel: cssModule("AllFilmsFiltersPanel", "sectionLabel"),
  accordion: cssModule("Accordion", "accordion"),
  accordionButton: cssModule("Accordion", "button"),
  accordionTitle: cssModule("Accordion", "title"),
  accordionRight: cssModule("Accordion", "right"),
  accordionIcon: cssModule("Accordion", "icon"),
  accordionContent: cssModule("Accordion", "content"),
  filterOption: cssModule("OptionButton", "kindFilter"),
  // Sort's options are the same pill; the Sort group starts open, so one is there to copy when no
  // filter group is open to show its own.
  sortOption: cssModule("OptionButton", "kindSort"),
  filterOptionLabel: cssModule("OptionButton", "label"),
};

// The site shows state with a second class from the same module ("…__title" gains "…__titleOpen").
// Our copies of its controls toggle the same classes, derived from the element's own, so they keep
// looking like the site's whatever the hash. [base element, state element] in cssModule's terms.
const STATE_CLASSES = {
  accordionTitleOpen: ["title", "titleOpen"],
  accordionIconOpen: ["icon", "iconOpen"],
  filterOptionActive: ["optionButton", "active"],
  sortOptionAsFilter: ["kindSort", "kindFilter"],
};

// The class for `state` on an element that already has the base class, e.g. "…__Xfr99W__titleOpen".
function stateClass(el, state) {
  const [base, variant] = STATE_CLASSES[state];
  const own = [...el.classList].find((c) => c.endsWith(`__${base}`));
  return own ? own.slice(0, -base.length) + variant : null;
}

// A single film's page, and the id every card links to: /films/<id>/<slug>, or /series/<id>/<slug>
// for a work in parts. The id is JW Player's media id, which is also what the API takes; the slug
// is cosmetic. Collections (/collections/…) and extras (/supplements/…) are deliberately not films.
const FILM_PATH = /^\/(?:films|series)\/([A-Za-z0-9]+)(?:\/|$)/;

function criterionId(href) {
  try {
    return new URL(href, SITE_ORIGIN).pathname.match(FILM_PATH)?.[1] || null;
  } catch {
    return null;
  }
}

const ALL_FILMS_PATH = "/all-films";

// A film's page. The slug is optional: /films/<id> redirects to /films/<id>/<slug>.
const filmHref = ({ id, type }) => `/${type === "series" ? "series" : "films"}/${id}`;

// A film's artwork, as the cards load it.
const posterUrl = (id, width) => `https://cdn.jwplayer.com/v2/media/${id}/images/default_16x9.webp?width=${width}`;
const POSTER_WIDTHS = [320, 480, 640, 960];

// "1 hr 27 min", "11 min", "2 hr": the site's own format, so our copies of its cards match.
function formatRuntime(minutes) {
  if (!(minutes > 0)) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h && `${h} hr`, m && `${m} min`].filter(Boolean).join(" ");
}

// One film's record: title, directors, release date. Public, no login needed.
const mediaUrl = (id) => `${SITE_ORIGIN}/api/media/${encodeURIComponent(id)}`;

// The whole catalog, a page at a time (the All Films page asks for 60; 200 is accepted). The page's
// own query string is the API's: ?genres=avant-garde&decades=1950s%2C1960s&sort=year&sortDir=desc
// on /all-films asks the API for exactly the list the page shows, so passing it along keeps the
// site's filters and sort.
const ALL_FILMS_PAGE = 200;
function allFilmsUrl(key = "1", search = "") {
  const params = new URLSearchParams(search);
  params.set("page_limit", ALL_FILMS_PAGE);
  params.set("pagination_key", key);
  return `${SITE_ORIGIN}/api/all-films/results?${params}`;
}

const yearOf = (date) => {
  const year = +String(date || "").slice(0, 4);
  return year >= 1870 && year <= 2100 ? year : null;
};

// /api/media/<id> -> { title, year, directors }, or null if it lacks what matching needs.
// `director` is a list; guard against a bare string in case that ever changes. An episode's title
// is bare ("Episode 1") where the catalog says "Joséphine en tournée: Episode 1"; the full one is
// its `title_original`, which is otherwise the original-language title and not what we want.
function parseMedia(json) {
  const bare = json?.title?.trim();
  const full = json?.title_original?.trim();
  const title = bare && full?.toLowerCase().endsWith(`: ${bare}`.toLowerCase()) ? full : bare;
  const year = yearOf(json?.release_date);
  const directors = [...new Set([].concat(json?.director || []).map((d) => String(d).trim()).filter(Boolean))];
  if (!title || !year || !directors.length) return null;
  return { title, year, directors };
}

// /api/all-films/results -> { films: [{ id, title, year, type, runtime }], next, total }. `type` is
// "film" or "series"; `runtime` is in minutes, null for a series. `year` is null where Criterion's
// date is unusable (a handful are dated 0000 or 2915); parseMedia usually has the right one. No
// directors here; those come from each film's parseMedia. `next` is null on the last page.
function parseAllFilms(json) {
  const films = [];
  for (const item of json?.items || []) {
    const id = item?.mediaid;
    const title = item?.title?.trim();
    const year = yearOf(item?.release_date);
    const runtime = Math.round(+item?.duration / 60) || null;
    if (id && title) films.push({ id, title, year, type: item.contentType || "film", runtime });
  }
  return { films, next: json?.paging?.next_pagination_key || null, total: json?.total ?? null };
}

if (typeof module !== "undefined") {
  module.exports = {
    SITE_ORIGIN,
    SELECTORS,
    STATE_CLASSES,
    ALL_FILMS_PATH,
    cssModule,
    stateClass,
    filmHref,
    posterUrl,
    POSTER_WIDTHS,
    formatRuntime,
    criterionId,
    mediaUrl,
    allFilmsUrl,
    parseMedia,
    parseAllFilms,
  };
}
