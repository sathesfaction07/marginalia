const API_BASE = "http://localhost:8000";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "QUERY") {
        handleQuery(message.payload).then(sendResponse);
        return true; // async response
    }
    if (message.type === "FEEDBACK") {
        handleFeedback(message.payload).then(sendResponse);
        return true;
    }
});

async function handleQuery({ query, region, process }) {
    try {
        const resp = await fetch(`${API_BASE}/api/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, region, process }),
        });

        if (!resp.ok) {
            const err = await resp.json();
            return { error: err.detail || "Request failed" };
        }

        const data = await resp.json();
        await cacheResult(query, data);
        return { success: true, data };
    } catch (e) {
        const cached = await getCachedResult(query);
        if (cached) return { success: true, data: cached, fromCache: true };
        return { error: "Service unavailable" };
    }
}

async function handleFeedback({ queryId, helpful, correction }) {
    try {
        await fetch(`${API_BASE}/api/feedback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query_id: queryId, helpful, correction }),
        });
        return { success: true };
    } catch {
        return { error: "Failed to submit feedback" };
    }
}

// One place to derive the key, and it tolerates a missing query.
//
// Previously both callers did `query.toLowerCase()` inline, so a message with no `query` threw
// inside cacheResult, the outer catch then threw AGAIN calling getCachedResult, and the second
// throw escaped -- so handleQuery REJECTED instead of returning an error object. Since the
// listener does `handleQuery(...).then(sendResponse)`, a rejection means sendResponse is never
// called and the popup waits for an answer that can never arrive.
function cacheKey(query) {
    return `cache:${String(query ?? "").toLowerCase().trim()}`;
}

async function cacheResult(query, data) {
    const key = cacheKey(query);
    const entry = { data, timestamp: Date.now() };
    await chrome.storage.local.set({ [key]: entry });
}

async function getCachedResult(query) {
    const key = cacheKey(query);
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (!entry) return null;

    const TTL_MS = 15 * 60 * 1000; // 15 minutes
    if (Date.now() - entry.timestamp > TTL_MS) {
        await chrome.storage.local.remove(key);
        return null;
    }
    return entry.data;
}
