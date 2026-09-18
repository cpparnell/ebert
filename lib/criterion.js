// films.criterionchannel.com lists the whole catalog (title, director, country, year) on one public page.
const CATALOG_URL = "https://films.criterionchannel.com/";
const CATALOG_KEY = "catalog";

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

// Some catalog cells are double-escaped ("Ken&amp;#039;ichi"), hence two passes.
const cellText = (s) =>
  decodeEntities(decodeEntities(s.replace(/<[^>]*>/g, ""))).replace(/\s+/g, " ").trim();

const splitDirectors = (s) => s.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean);

// A film's collection page (/m-1) and its video page (/videos/m) can have different slugs,
// so this catches most cards, not all; the rest fall back to fetching the page.
function criterionSlug(href) {
  return new URL(href, "https://www.criterionchannel.com/").pathname.split("/").filter(Boolean).pop();
}

// Parsed with regexes rather than DOMParser, which the background service worker doesn't have.
// Returns { slug: { title, year, directors } }, skipping rows without a plausible year.
function parseCatalog(html) {
  const out = {};
  const rows = html.match(/<tr class="criterion-channel__tr"[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) {
    const href = row.match(/data-href="([^"]+)"/)?.[1];
    const cell = (name) => {
      const m = row.match(new RegExp(`criterion-channel__td--${name}">([\\s\\S]*?)</td>`));
      return m ? cellText(m[1]) : "";
    };
    const title = cell("title");
    const year = cell("year");
    if (!href || !title || !/^(18|19|20)\d\d$/.test(year)) continue;
    out[criterionSlug(href)] = { title, year: +year, directors: splitDirectors(cell("director")) };
  }
  return out;
}

if (typeof module !== "undefined") {
  module.exports = { CATALOG_URL, parseCatalog, criterionSlug, splitDirectors, decodeEntities };
}
