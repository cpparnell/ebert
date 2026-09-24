const form = document.getElementById("form");
const input = document.getElementById("username");
const statusLine = document.getElementById("status");
const syncButton = document.getElementById("sync");

function render() {
  const status = cachePeek(USER_STATUS_KEY)?.v;
  const username = cachePeek(USERNAME_KEY)?.v;
  // A status left over from a previous username says nothing about this one.
  const current = status?.username === username ? status : null;
  statusLine.textContent = username ? describeSync(current) : "";
  statusLine.dataset.state = current?.state || "";
  syncButton.hidden = !username || current?.state === "syncing";
}

const sync = (force) => chrome.runtime.sendMessage({ type: "syncUser", force });

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = input.value.trim();
  const username = normalizeUsername(raw);
  if (raw && !username) {
    statusLine.textContent = "That doesn't look like a Letterboxd username.";
    statusLine.dataset.state = "error";
    return;
  }
  input.value = username || "";
  if (username) await cacheSet(USERNAME_KEY, username, 3650 * DAY_MS);
  else await chrome.storage.local.remove(USERNAME_KEY);
  render();
  sync(true);
});

syncButton.addEventListener("click", () => sync(true));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (USER_STATUS_KEY in changes || USERNAME_KEY in changes)) render();
});

cacheReady.then(() => {
  input.value = cachePeek(USERNAME_KEY)?.v || "";
  render();
});
