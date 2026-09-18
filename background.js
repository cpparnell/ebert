importScripts("lib/shared.js", "lib/letterboxd.js", "lib/snapshot.js");

const HIT_TTL = 7 * DAY_MS;
const MISS_TTL = 3 * DAY_MS;
const SNAPSHOT_ALARM = "ebert-snapshot";
const SNAPSHOT_CHECK_MS = 6 * 60 * 60 * 1000;
const letterboxdLimit = limiter(5);
const letterboxdFetch = (url, init) => politeFetch(letterboxdLimit, url, init);
const inflight = new Map();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "lookup") return;
  lookup(msg.film).then(
    (film) => sendResponse({ film }),
    (err) => {
      console.warn("[ebert]", err);
      sendResponse({ error: String(err.message || err) });
    }
  );
  return true;
});

async function lookup(film) {
  const key = lbKey(film);
  const cached = await cacheGet(key);
  // The shared snapshot covers the catalog. Its misses still get a live lookup: the nightly build
  // runs without browser cookies, so Letterboxd's search fallback is blocked for it.
  const shared = snapshotByKey(cachePeek(SNAPSHOT_KEY)?.v).get(key);
  if (shared) return shared;
  if (cached && !cached.stale) return cached.v;
  const pending = refresh(key, film);
  // Ratings drift slowly, so a stale hit is served now and refreshed behind it.
  // A stale miss is worth waiting on: the film may have been added to Letterboxd since.
  if (cached?.v) {
    pending.catch((err) => console.warn("[ebert] refresh failed", film, err));
    return cached.v;
  }
  return pending;
}

function refresh(key, film) {
  if (!inflight.has(key)) {
    const pending = resolveFilm(film, letterboxdFetch)
      .then(async (result) => {
        if (!result) console.info("[ebert] no Letterboxd match", film);
        await cacheSet(key, result, result ? HIT_TTL : MISS_TTL);
        return result;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return inflight.get(key);
}

// Misses cached by an older matcher may resolve now, so drop them whenever the extension updates,
// along with state from the old per-install crawler.
chrome.runtime.onInstalled.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(
    Object.keys(all).filter(
      (k) => (k.startsWith("lb:") && all[k]?.v == null) || k === "catalog" || k === "crawl:backoff"
    )
  );
});

function startSnapshotSync() {
  chrome.alarms.create(SNAPSHOT_ALARM, { periodInMinutes: 60 });
  syncSnapshot();
}
chrome.runtime.onInstalled.addListener(startSnapshotSync);
chrome.runtime.onStartup.addListener(startSnapshotSync);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SNAPSHOT_ALARM) syncSnapshot();
});

// Checked every few hours; "no-cache" revalidates against GitHub Pages' ETag, so an unchanged
// snapshot costs a 304, not a download. It's only replaced, never expired, so it works offline.
async function syncSnapshot() {
  try {
    await cacheReady;
    if (cachePeek("snapshot:checked")?.stale === false) return;
    const res = await fetch(SNAPSHOT_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`snapshot responded ${res.status}`);
    const snapshot = await res.json();
    if (!snapshot?.generatedAt || !snapshot.films) throw new Error("snapshot malformed");
    if (snapshot.generatedAt !== cachePeek(SNAPSHOT_KEY)?.v?.generatedAt) {
      await cacheSet(SNAPSHOT_KEY, snapshot, 3650 * DAY_MS);
    }
    await cacheSet("snapshot:checked", true, SNAPSHOT_CHECK_MS);
  } catch (err) {
    console.warn("[ebert] snapshot sync failed", err);
  }
}
