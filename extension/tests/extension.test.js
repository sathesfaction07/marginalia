/**
 * Tests for the shipped extension scripts, with no dependencies beyond `node:test`.
 *
 * The extension files are plain scripts, not modules -- a service worker and a content script,
 * loaded by the browser with no `export` anywhere. Rather than refactor production code to make
 * it importable, each file is loaded AS SHIPPED into a fresh `vm` context with `chrome` and
 * `fetch` mocked. That way the thing under test is the byte-for-byte artifact the browser runs.
 *
 *     node --test extension/tests/
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..");
const TTL_MS = 15 * 60 * 1000;

/**
 * Re-create a value with this realm's prototypes.
 *
 * Objects the script builds live in the `vm` context, so they carry ITS Object.prototype.
 * `deepStrictEqual` compares prototypes, so it reports "same structure but not
 * reference-equal" on values that are plainly equal. Round-tripping through JSON drops the
 * prototype question entirely while keeping strict comparison of the data.
 */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** A minimal chrome.* double that records what the script asked it to do. */
function makeChrome() {
  const local = new Map();
  const session = new Map();
  const listeners = [];
  return {
    calls: { removed: [], sessionSet: [] },
    runtime: {
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
      },
    },
    storage: {
      local: {
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) local.set(k, v);
        },
        async get(key) {
          return local.has(key) ? { [key]: local.get(key) } : {};
        },
        async remove(key) {
          local.delete(key);
        },
      },
      session: {
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) session.set(k, v);
        },
      },
    },
    _local: local,
    _session: session,
    _listeners: listeners,
  };
}

/** Load the service worker as shipped, with injected globals. */
function loadServiceWorker({ fetchImpl = async () => ({ ok: true, json: async () => ({}) }) } = {}) {
  const chrome = makeChrome();
  const removed = [];
  const origRemove = chrome.storage.local.remove;
  chrome.storage.local.remove = async (key) => {
    removed.push(key);
    return origRemove.call(chrome.storage.local, key);
  };
  // `String` is needed because cacheKey() coerces a possibly-missing query with it.
  const context = { chrome, fetch: fetchImpl, console, Date, JSON, String };
  vm.createContext(context);
  const source = fs.readFileSync(
    path.join(EXT, "src/background/service-worker.js"),
    "utf8",
  );
  vm.runInContext(source, context);
  return { context, chrome, removed };
}

test("the cache key ignores case and surrounding whitespace", async () => {
  const { context, chrome } = loadServiceWorker();
  await context.cacheResult("  Age Restricted  ", { answer: "x" });
  const keys = [...chrome._local.keys()];
  assert.deepStrictEqual(keys, ["cache:age restricted"]);

  // So a differently-typed but equivalent query is a HIT, which is the point of normalising.
  const hit = await context.getCachedResult("AGE RESTRICTED");
  assert.deepStrictEqual(plain(hit), { answer: "x" });
});

test("a fresh entry is returned and a stale one is not", async () => {
  const { context } = loadServiceWorker();
  await context.cacheResult("q", { answer: "fresh" });
  assert.deepStrictEqual(plain(await context.getCachedResult("q")), { answer: "fresh" });

  // Rewrite the entry as if it were written just over the TTL ago.
  await context.chrome.storage.local.set({
    "cache:q": { data: { answer: "old" }, timestamp: Date.now() - TTL_MS - 1 },
  });
  assert.strictEqual(await context.getCachedResult("q"), null);
});

test("an expired entry is DELETED, not merely ignored", async () => {
  const { context, chrome, removed } = loadServiceWorker();
  await chrome.storage.local.set({
    "cache:q": { data: { answer: "old" }, timestamp: Date.now() - TTL_MS - 1 },
  });
  assert.strictEqual(await context.getCachedResult("q"), null);
  assert.deepStrictEqual(removed, ["cache:q"], "the stale key must be evicted");
  assert.strictEqual(chrome._local.has("cache:q"), false);
});

test("the TTL boundary is exclusive, so an entry exactly at the limit still counts", async () => {
  // Pins `>` rather than `>=`. Not a bug either way, but it is a decision, and a test that
  // does not pin it lets the boundary drift silently.
  const { context, chrome } = loadServiceWorker();
  await chrome.storage.local.set({
    "cache:q": { data: { answer: "edge" }, timestamp: Date.now() - TTL_MS },
  });
  assert.deepStrictEqual(plain(await context.getCachedResult("q")), { answer: "edge" });
});

test("a missing entry is null rather than undefined", async () => {
  const { context } = loadServiceWorker();
  assert.strictEqual(await context.getCachedResult("never-stored"), null);
});

test("a successful query is returned and cached", async () => {
  const payload = { answer: "use Template A", confidence: "high" };
  const { context, chrome } = loadServiceWorker({
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  const result = await context.handleQuery({ query: "Appeal", region: "US" });
  assert.deepStrictEqual(plain(result), { success: true, data: payload });
  assert.deepStrictEqual(plain(chrome._local.get("cache:appeal").data), payload);
});

test("an HTTP error surfaces the server's detail and does NOT fall back to the cache", async () => {
  // The asymmetry is deliberate to record: a THROWN fetch (offline) falls back to cache, while
  // a non-ok RESPONSE (a 500) does not, even when a usable cached answer exists. Whether that
  // is the right product decision is arguable; it is the shipped behaviour, so it is pinned
  // here rather than discovered later.
  const { context } = loadServiceWorker({
    fetchImpl: async () => ({ ok: false, json: async () => ({ detail: "region unknown" }) }),
  });
  await context.cacheResult("appeal", { answer: "cached answer" });
  const result = await context.handleQuery({ query: "Appeal", region: "ZZ" });
  assert.deepStrictEqual(plain(result), { error: "region unknown" });
  assert.strictEqual(result.data, undefined, "no cached data on an HTTP error");
});

test("an HTTP error with no detail still yields a message", async () => {
  const { context } = loadServiceWorker({
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });
  assert.deepStrictEqual(plain(await context.handleQuery({ query: "q" })), {
    error: "Request failed",
  });
});

test("a network failure falls back to the cache and says that it did", async () => {
  const { context } = loadServiceWorker({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  await context.cacheResult("appeal", { answer: "cached answer" });
  const result = await context.handleQuery({ query: "Appeal" });
  assert.deepStrictEqual(plain(result), {
    success: true,
    data: { answer: "cached answer" },
    fromCache: true,
  });
  assert.strictEqual(result.fromCache, true, "the caller must be able to tell");
});

test("a network failure with an empty cache reports unavailability", async () => {
  const { context } = loadServiceWorker({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.deepStrictEqual(plain(await context.handleQuery({ query: "nothing cached" })), {
    error: "Service unavailable",
  });
});

test("a network failure with an EXPIRED cache entry reports unavailability", async () => {
  const { context, chrome } = loadServiceWorker({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  await chrome.storage.local.set({
    "cache:q": { data: { answer: "old" }, timestamp: Date.now() - TTL_MS - 1 },
  });
  assert.deepStrictEqual(plain(await context.handleQuery({ query: "q" })), {
    error: "Service unavailable",
  });
});

test("feedback posts the snake_case body the backend expects", async () => {
  let sent = null;
  const { context } = loadServiceWorker({
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return { ok: true, json: async () => ({}) };
    },
  });
  const result = await context.handleFeedback({
    queryId: "q-1",
    helpful: false,
    correction: "wrong template",
  });
  assert.deepStrictEqual(plain(result), { success: true });
  assert.deepStrictEqual(plain(sent), {
    query_id: "q-1",
    helpful: false,
    correction: "wrong template",
  });
});

test("feedback reports its own failure rather than throwing", async () => {
  const { context } = loadServiceWorker({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.deepStrictEqual(plain(await context.handleFeedback({ queryId: "q" })), {
    error: "Failed to submit feedback",
  });
});

test("QUERY and FEEDBACK both return true, which is what keeps the port open", async () => {
  const { chrome } = loadServiceWorker();
  const [listener] = chrome._listeners;
  assert.strictEqual(listener.length >= 3, true, "listener takes (message, sender, respond)");
  // A payload with a real query, and awaited, so no async work escapes the test.
  const answers = [];
  assert.strictEqual(
    listener({ type: "QUERY", payload: { query: "q" } }, null, (r) => answers.push(r)),
    true,
  );
  assert.strictEqual(
    listener({ type: "FEEDBACK", payload: { queryId: "q" } }, null, (r) => answers.push(r)),
    true,
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(answers.length, 2, "both handlers must call sendResponse");
});

test("an UNKNOWN message type returns undefined and never answers", async () => {
  // A real defect in the shipped script, recorded rather than silently patched: the listener
  // has no else branch, so it returns undefined for anything it does not recognise. Chrome
  // then closes the port without calling sendResponse, and the caller's promise never settles.
  // Pinned so that if somebody adds the else branch, this test tells them the contract changed.
  const { chrome } = loadServiceWorker();
  const [listener] = chrome._listeners;
  let answered = false;
  const returned = listener({ type: "SOMETHING_ELSE" }, null, () => {
    answered = true;
  });
  assert.strictEqual(returned, undefined, "no port kept open");
  assert.strictEqual(answered, false, "and no response sent -- the caller hangs");
});

test("a message with no query resolves to an error instead of hanging the popup", async () => {
  // THE DEFECT, found by writing these tests: both callers derived the cache key with an
  // inline `query.toLowerCase()`. A message with no `query` threw inside cacheResult, the
  // outer catch threw AGAIN calling getCachedResult, and the second throw escaped -- so
  // handleQuery REJECTED. The listener does `.then(sendResponse)`, so nothing ever answered
  // and the popup waited forever. Now `cacheKey` coerces a missing query.
  const { context } = loadServiceWorker({
    fetchImpl: async () => ({ ok: true, json: async () => ({ answer: "x" }) }),
  });
  const result = await context.handleQuery({});
  assert.deepStrictEqual(plain(result), { success: true, data: { answer: "x" } });
  assert.strictEqual(context.cacheKey(undefined), "cache:");
  assert.strictEqual(context.cacheKey(null), "cache:");
  assert.strictEqual(context.cacheKey("  Foo  "), "cache:foo");
});

// --------------------------------------------------------------------------------------
// content.js -- an IIFE, so the globals have to exist before it is evaluated at all.
// --------------------------------------------------------------------------------------
function loadContentScript({ bodyText, readyState = "complete" }) {
  const chrome = makeChrome();
  const listeners = [];
  const context = {
    chrome,
    console,
    document: { body: { innerText: bodyText }, readyState },
    window: {
      addEventListener(event, fn) {
        listeners.push([event, fn]);
      },
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(EXT, "src/content/content.js"), "utf8");
  vm.runInContext(source, context);
  return { chrome, listeners };
}

test("the case id is detected across the separator spellings", async () => {
  for (const text of [
    "Case ID: ABC-123 and more",
    "case_id ABC-123",
    "case-id: ABC-123",
    "caseid:ABC-123",
    "CASE ID: ABC-123",
  ]) {
    const { chrome } = loadContentScript({ bodyText: text });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(
      chrome._session.get("currentCaseId"),
      "ABC-123",
      `failed for ${JSON.stringify(text)}`,
    );
  }
});

test("the spelling a human sees -- 'Case ID:' -- is matched, and so is the cost of that", async () => {
  // THE DEFECT: the separator class was `[_-]?`, with no space, so `case_id`, `case-id` and
  // `caseid` matched while "Case ID: ABC-123" -- how a page actually renders it -- did not.
  // The script missed the single most common form of the thing it exists to find.
  const spaced = loadContentScript({ bodyText: "Reference Case ID: ABC-123 opened today" });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(spaced.chrome._session.get("currentCaseId"), "ABC-123");

  // And the accepted cost, pinned so it is a known limit rather than a surprise: one optional
  // space also lets an ordinary sentence match. A wrong pre-filled id is visible and editable;
  // never pre-filling anything is invisible, which is why the trade was made this way.
  const overreach = loadContentScript({ bodyText: "in case Idaho is warm" });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(overreach.chrome._session.get("currentCaseId"), "aho");
});

test("nothing is stored when the page holds no case id", async () => {
  const { chrome } = loadContentScript({ bodyText: "an ordinary page about nothing" });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(chrome._session.has("currentCaseId"), false);
});

test("an empty or missing body does not throw", async () => {
  for (const bodyText of ["", undefined, null]) {
    const { chrome } = loadContentScript({ bodyText });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(chrome._session.has("currentCaseId"), false);
  }
});

test("only the first 5000 characters are scanned", async () => {
  // The truncation is a real limit, not a detail: an id past the cut-off is invisible, so the
  // extension silently fails to pre-populate on a long page.
  const padded = "x".repeat(5000) + " Case ID: LATE-1";
  const { chrome } = loadContentScript({ bodyText: padded });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(chrome._session.has("currentCaseId"), false);

  const inRange = "Case ID: EARLY-1 " + "x".repeat(6000);
  const second = loadContentScript({ bodyText: inRange });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(second.chrome._session.get("currentCaseId"), "EARLY-1");
});

test("detection is deferred until load when the document is still parsing", async () => {
  const { chrome, listeners } = loadContentScript({
    bodyText: "Case ID: ABC-123",
    readyState: "loading",
  });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(chrome._session.has("currentCaseId"), false, "not yet");
  assert.deepStrictEqual(listeners.map(([event]) => event), ["load"]);

  listeners[0][1]();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(chrome._session.get("currentCaseId"), "ABC-123");
});

// --------------------------------------------------------------------------------------
// manifest.json -- a manifest that points at a file which does not exist is a broken
// extension that installs and then does nothing, so the paths are checked as data.
// --------------------------------------------------------------------------------------
test("every file the manifest names actually exists", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
  ];
  assert.strictEqual(referenced.length, 3);
  for (const rel of referenced) {
    assert.strictEqual(fs.existsSync(path.join(EXT, rel)), true, `missing: ${rel}`);
  }
});

test("the manifest declares the permissions the code actually uses", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const worker = fs.readFileSync(path.join(EXT, "src/background/service-worker.js"), "utf8");
  const content = fs.readFileSync(path.join(EXT, "src/content/content.js"), "utf8");

  assert.strictEqual(manifest.manifest_version, 3);
  // Both scripts touch chrome.storage, so the permission is load-bearing.
  assert.match(worker, /chrome\.storage\.local/);
  assert.match(content, /chrome\.storage\.session/);
  assert.ok(manifest.permissions.includes("storage"));

  // And the worker only ever calls the host it is permitted to reach.
  const base = worker.match(/const API_BASE = "([^"]+)"/)[1];
  assert.strictEqual(base, "http://localhost:8000");
  assert.ok(
    manifest.host_permissions.some((pattern) => pattern.startsWith(base)),
    `host_permissions ${JSON.stringify(manifest.host_permissions)} must cover ${base}`,
  );
});
