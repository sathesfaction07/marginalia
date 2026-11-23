# ADR-001: Working Within Manifest V3 Constraints

## Status
Accepted

## Context
Chrome is deprecating Manifest V2. MV3 removes persistent background pages — the service worker is terminated after ~30 seconds of inactivity. This fundamentally changes how the extension maintains state.

## Decision
Use `chrome.storage.local` as the persistence layer with a 15-minute TTL cache. The service worker is stateless — every query either hits the backend API or the storage cache.

## Why

In MV2, the background page stayed alive and could hold an in-memory cache indefinitely. In MV3, any in-memory state is lost when the service worker terminates. Options considered:

1. **In-memory cache + re-warm on wake** — fragile. The service worker restarts cold frequently. Re-warming from API on every wake adds latency.
2. **chrome.storage.local with TTL** — chosen. Persists across service worker restarts. Storage API is async but fast (~1ms for small values). TTL prevents stale answers from lingering.
3. **IndexedDB** — overkill for key-value cache of string responses. More API surface to get wrong.

## Tradeoffs
- Storage has a 10MB limit per extension (5MB for `sync`). With ~500 byte average per cached response and 15-min TTL, we'd need thousands of concurrent queries to hit this. Not a concern.
- Writes are async. A race condition exists if the same query fires twice before the first write completes — both hit the API. Acceptable; duplicate API calls are cheap.
