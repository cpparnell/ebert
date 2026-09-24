const DAY_MS = 24 * 60 * 60 * 1000;

class Cancelled extends Error {}

// Everything first paint needs, read on its own so a page doesn't wait on the rest of the store:
// the snapshot alone is 600KB+, and the per-film lb:/cc4: entries behind it grow without bound.
// The names are spelled out because lib/snapshot.js, lib/user.js and content.js define them but
// load after this file.
const HOT_KEYS = ["snapshot", "snapshot:checked", "user", "user:name", "user:status", "catalog:filters"];

// Whole store mirrored in memory, so lookups (and first paint) don't wait on storage round-trips.
const cacheMem = new Map();
const cacheOwn = new Set(); // written or changed in this context since load; the backfill skips these

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    cacheOwn.add(key);
    if (newValue === undefined) cacheMem.delete(key);
    else cacheMem.set(key, newValue);
  }
});

// A read that started before a change landed must not undo it.
const cacheMerge = (entries) => {
  for (const [key, entry] of Object.entries(entries)) if (!cacheOwn.has(key)) cacheMem.set(key, entry);
};

// cacheReady is the hot keys, cacheFull the whole store behind them. Callers that can await get the
// full mirror, so a key that hasn't landed yet is never mistaken for a miss; synchronous peeks may
// miss a cold entry during the backfill and just take a slower path to the same answer.
const cacheReady = chrome.storage.local.get(HOT_KEYS).then(cacheMerge);
const cacheFull = cacheReady.then(() => chrome.storage.local.get(null)).then(cacheMerge);

// Expired entries are still returned, flagged stale, so callers can show them while refreshing.
function cachePeek(key) {
  const entry = cacheMem.get(key);
  return entry && { v: entry.v, stale: entry.exp < Date.now() };
}

async function cacheGet(key) {
  await cacheFull;
  return cachePeek(key);
}

async function cacheSet(key, value, ttlMs) {
  const entry = { v: value, exp: Date.now() + ttlMs };
  cacheOwn.add(key);
  cacheMem.set(key, entry);
  await chrome.storage.local.set({ [key]: entry });
}

// Runs at most `max` tasks at once, newest first: the latest request is usually for what's on screen.
// A task whose `wanted()` is false by the time its turn comes is rejected with Cancelled instead.
function limiter(max) {
  let active = 0;
  let pausedUntil = 0;
  let timer = null;
  const stack = [];
  const next = () => {
    const wait = pausedUntil - Date.now();
    if (wait > 0) {
      timer ??= setTimeout(() => {
        timer = null;
        next();
      }, wait);
      return;
    }
    while (active < max && stack.length) {
      const { fn, wanted, resolve, reject } = stack.pop();
      if (wanted && !wanted()) {
        reject(new Cancelled());
        continue;
      }
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          next();
        });
    }
  };
  const run = (fn, wanted) =>
    new Promise((resolve, reject) => {
      stack.push({ fn, wanted, resolve, reject });
      next();
    });
  run.pause = (ms) => {
    pausedUntil = Math.max(pausedUntil, Date.now() + ms);
  };
  run.idle = () => active === 0 && !stack.length && pausedUntil <= Date.now();
  return run;
}

// Fetch through a limiter; when the server says slow down, the whole limiter backs off, then retries.
async function politeFetch(limit, url, init, wanted) {
  for (let attempt = 0; ; attempt++) {
    const res = await limit(() => fetch(url, init), wanted);
    if ((res.status !== 429 && res.status !== 503) || attempt >= 3) return res;
    const retryAfter = +res.headers.get("retry-after");
    limit.pause(retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
  }
}
