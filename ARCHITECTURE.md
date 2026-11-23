# Marginalia — Technical Architecture

## Overview

Marginalia is a grounded-retrieval tool that answers compliance associate queries using ONLY retrieved SOP text. A Chrome MV3 extension sends queries to a Flask backend that performs semantic search across regional knowledge bases, constructs a context-constrained prompt with conversation history, invokes AWS Bedrock Claude for answer generation, and maintains multi-turn sessions. Supports three swappable retrieval backends with increasing accuracy: keyword (zero dependencies), ChromaDB (local vector search), and Bedrock Knowledge Bases (managed RAG).

**Design principle:** Retrieval defines truth. The LLM answers only from retrieved text and must abstain when context is insufficient rather than fabricate a plausible-sounding response.

---

## System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                      CHROME EXTENSION (MV3)                              │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ Popup (popup.html + popup.js)                                      │ │
│  │ - Region selector (US/CA/AU/SG/DE/FR)                              │ │
│  │ - Query textarea + submit button                                   │ │
│  │ - Result display: answer + confidence badge + sources              │ │
│  │ - Feedback buttons (helpful / not helpful)                         │ │
│  └─────────────────────────┬─────────────────────────────────────────┘ │
│                            │ chrome.runtime.sendMessage                │
│                            ▼                                            │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ Service Worker (background/service-worker.js)                      │ │
│  │ - Stateless: terminates after 30s inactivity (MV3 constraint)     │ │
│  │ - Handles QUERY and FEEDBACK message types                         │ │
│  │ - Calls backend API (fetch)                                        │ │
│  │ - chrome.storage.local cache (15-min TTL)                          │ │
│  │ - Fallback to cached response if API unreachable                   │ │
│  └─────────────────────────┬─────────────────────────────────────────┘ │
│                            │ HTTP POST                                  │
└────────────────────────────┼────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     FASTAPI BACKEND (Port 8000)                          │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ Endpoints (app.py):                                                │ │
│  │   GET  /health            → Health check + backend config          │ │
│  │   POST /api/query         → Main query handler                     │ │
│  │   POST /api/feedback      → Record helpful/not-helpful + text      │ │
│  │   GET  /api/regions       → List supported regions                 │ │
│  │   POST /api/index         → Index documents (chromadb backend)     │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                            │                                            │
│                            ▼                                            │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ SessionStore (session.py)                                          │ │
│  │ - In-memory session storage with TTL (30 min default)              │ │
│  │ - Tracks multi-turn conversation history per session               │ │
│  │ - Returns last N turns as messages for LLM context                 │ │
│  └─────────────────┬────────────────────────┬────────────────────────┘ │
│                    │                        │                          │
│                    ▼                        ▼                          │
│  ┌────────────────────────────┐  ┌──────────────────────────────────┐ │
│  │ Retrieval Layer            │  │ QueryEngine (llm.py)              │ │
│  │ (retrieval/__init__.py)    │  │ - 11-rule system prompt           │ │
│  │                            │  │ - Bedrock Claude invocation       │ │
│  │  ┌──────────────────────┐  │  │ - Prompt with context + history   │ │
│  │  │ KeywordBackend        │  │  │ - Confidence from retrieval score │ │
│  │  │ Token overlap scorer  │  │  │ - Abstention rule (Rule 3)        │ │
│  │  │ Zero dependencies     │  │  │ - Prompt caching (ephemeral)      │ │
│  │  └──────────────────────┘  │  └──────────────────────────────────┘ │
│  │  ┌──────────────────────┐  │                                        │
│  │  │ ChromaDBBackend      │  │                                        │
│  │  │ sentence-transformers │  │                                        │
│  │  │ Local vector store   │  │                                        │
│  │  └──────────────────────┘  │                                        │
│  │  ┌──────────────────────┐  │                                        │
│  │  │ BedrockKBBackend     │  │                                        │
│  │  │ Managed RAG service  │  │                                        │
│  │  │ S3-backed indexing   │  │                                        │
│  │  └──────────────────────┘  │                                        │
│  └────────────────────────────┘                                        │
└────────────────────────┬───────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                         EXTERNAL SERVICES                                │
│                                                                         │
│  ┌──────────────────────────────────┐                                  │
│  │ AWS Bedrock                       │                                  │
│  │ Model: claude-sonnet-4-6          │                                  │
│  │ Region: us-east-1                 │                                  │
│  │ Temperature: 0                    │                                  │
│  │ Max tokens: 500                   │                                  │
│  │ Prompt caching: ephemeral         │                                  │
│  │                                   │                                  │
│  │ Optional: Bedrock Knowledge Bases │                                  │
│  │ (for bedrock_kb retrieval mode)   │                                  │
│  └──────────────────────────────────┘                                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Chrome Extension (`extension/`)

**manifest.json** — MV3 configuration
- Permissions: storage (for cache), activeTab (for context detection)
- Service worker replaces persistent background page (MV3 requirement)
- Content script runs on all pages at `document_idle` to detect case context

**popup.html + popup.js** — Query interface
- Region dropdown pre-populates from backend's supported regions
- Textarea for natural-language query (Enter submits, Shift+Enter newline)
- Confidence badge color-coded: high (green), medium (yellow), low (red)
- Cache badge displays `(cached)` when result served from storage
- Sources list shows SOP section titles
- Feedback buttons call `/api/feedback` endpoint

**service-worker.js** — Stateless API client with caching
- Handles `QUERY` and `FEEDBACK` message types from popup
- Cache key: normalized lowercase query string
- Cache entry: `{data, timestamp}` stored in `chrome.storage.local`
- TTL: 15 minutes (configurable)
- Fallback: if API call fails, checks cache and returns stale result if present

**content.js** — Page context detection
- Extracts case IDs from page text (pattern: `case_id:`, `case-id:`, `caseID:`)
- Stores in `chrome.storage.session` for potential auto-population in popup
- Currently unused by popup, but infrastructure exists for future enhancement

| Endpoint | Method | Purpose |
|:--|:--|:--|
| `/health` | GET | Service health, uptime, request count, backend config |
| `/api/query` | POST | Accept `{query, region, process?, session_id?}`, return answer + confidence + sources + session_id |
| `/api/feedback` | POST | Accept `{query_id, helpful, correction?}`, log feedback (no action yet) |
| `/api/regions` | GET | List supported regions (from config) |
| `/api/index` | POST | Index documents for a region (chromadb backend only) |

### 2. Flask API (`backend/src/policy_assist/app.py`)

**Initialization**
- Instantiates retrieval backend from factory based on `PA_RETRIEVAL_BACKEND` env var
- Creates single `QueryEngine` instance (reuses Bedrock client)
- Creates `SessionStore` with configurable TTL

**POST /api/query** — Main query handler
1. Validates region is in supported list
2. Gets or creates session (generates UUID if no session_id provided)
3. Calls retrieval backend: `search(query, region, process, top_k)`
4. Returns 404 if no relevant chunks found
5. Fetches conversation history from session (last N turns)
6. Calls LLM: `answer(query, context, region, history)`
7. Stores turn in session: `add_turn(query, answer.text, answer.sources)`
8. Returns: `{answer, confidence, sources, region, session_id}`

**POST /api/feedback** — Logs feedback
- Structured logging: `query_id`, `helpful`, `correction` length
- Placeholder for future review queue (DynamoDB/S3 comment in code)

**GET /health** — Service status
- Uptime in seconds
- Total requests served (in-memory counter)
- Active retrieval backend
- Supported regions list

### 3. Retrieval Layer (`backend/src/policy_assist/retrieval/`)

**base.py** — Abstract interface
- `RetrievedChunk` dataclass: title, content, process, score, source_file
- `RetrievalBackend` ABC with two methods: `search()`, `index_documents()`

**keyword.py** — Token overlap scorer (default)
- Loads JSON files from `data/knowledge_bases/{region}.json`
- In-memory cache per region
- Scoring: title matches ×3, keyword matches ×5, content matches ×1
- Process filter: if `process` param provided, narrows to matching documents first
- Zero dependencies, works immediately after clone

**chromadb_backend.py** — Vector similarity search
- Uses `sentence-transformers` with `all-MiniLM-L6-v2` model
- Persistent storage in `.chromadb` directory (configurable)
- Collection per region: `kb_{region_lower}`
- Embeds document content, stores title + process in metadata
- Score: `1.0 - cosine_distance`
- Requires `pip install "marginalia[chromadb]"` + one-time indexing

**bedrock_kb.py** — AWS managed RAG
- Uses `bedrock-agent-runtime` client's `retrieve()` API
- Requires Bedrock Knowledge Base ID (env var `PA_BEDROCK_KB_ID`)
- Indexing managed via S3 data source sync (not exposed via this interface)
- Returns chunks with scores from Bedrock's ranking algorithm
- Source file URI extracted from `location.s3Location.uri`

| Backend | How it matches | Needs infra? | When to use |
|:--|:--|:--|:--|
| `keyword` | Token overlap (title ×3, keywords ×5, content ×1) | No | Development, demos, offline environments |
| `chromadb` | Vector similarity (sentence-transformers embeddings) | Local only | Production — best accuracy without AWS costs |
| `bedrock_kb` | AWS managed RAG (auto-embeddings + S3 sync) | Yes — AWS setup | Production — hands-off indexing, managed scaling |

### 4. LLM Layer (`backend/src/policy_assist/llm.py`)

**QueryEngine** — Answer generation
- Single boto3 `bedrock-runtime` client (reused across requests)
- `answer(query, context, region, history)` method

**11-rule system prompt**
1. Answer directly, no hedging
2. If answer is in context, give it with section reference
3. If NOT in context: "This query requires SME review" (abstention rule)
4. Structure: answer first, then cite source
5. Use region-specific guidance
6. If multiple SOPs apply, list in priority order
7. Never invent procedures
8. Keep under 200 words
9. If ambiguous, ask ONE clarifying question
10. Format action steps as numbered lists, references as [Section: Title]
11. Respond in query language but reference English SOP section names

**Prompt structure**
- System prompt with cache_control (ephemeral) to reuse across requests
- User prompt: `REGION: {region}\nQUERY: {query}\n\nRELEVANT SOP SECTIONS:\n--- Section 1: {title} (relevance: {score}) ---\n{content}\n...`
- If multi-turn: inserts prior conversation as alternating user/assistant messages

**Confidence assessment**
- Based on retrieval quality, not LLM certainty
- High: avg_score > 0.8 AND ≥3 chunks
- Medium: avg_score > 0.5 OR ≥2 chunks
- Low: otherwise

### 5. Session Management (`backend/src/policy_assist/session.py`)

**Session** dataclass
- `session_id`: UUID v4
- `turns`: list of Turn objects (query, answer, sources, timestamp)
- `region`: set at creation, immutable
- `created_at`: timestamp for TTL enforcement

**Turn** dataclass
- `query`: user question
- `answer`: LLM response text
- `sources`: list of SOP section titles
- `timestamp`: when turn was created

**SessionStore** — In-memory store with TTL
- `_sessions`: dict[str, Session]
- `_ttl`: seconds (default 30 min)
- `get_or_create(session_id, region)`: returns existing or new session
- `get_history_messages(max_turns)`: returns last N turns as alternating user/assistant dicts for LLM context
- `_cleanup()`: called on every access, deletes expired sessions

---

## Data Flow

```
1. User types "How do I handle a third-time rejection?" in popup, selects US region
2. Popup JS sends chrome.runtime.sendMessage({type: "QUERY", payload: {query, region: "US", process: ""}})
3. Service worker receives message, checks cache (miss), calls POST localhost:8000/api/query
4. Backend validates region, creates/retrieves session (generates session_id if new)
5. Backend calls retrieval.search("How do I handle...", "US", "", top_k=5)
6. Retrieval backend (e.g., chromadb) embeds query, searches vector store, returns top 5 chunks with scores
7. Backend fetches conversation history from session (empty if first turn)
8. Backend calls query_engine.answer(query, chunks, "US", history=None)
9. QueryEngine builds prompt with context sections, invokes Bedrock Claude Sonnet with system prompt
10. Bedrock returns answer text (e.g., "Use Template C for third rejections. Include empathetic language...")
11. QueryEngine assesses confidence from chunk scores (e.g., avg=0.92, count=4 → "high")
12. Backend stores turn in session: session.add_turn(query, answer_text, sources)
13. Backend returns JSON: {answer, confidence: "high", sources: ["Merchant Appeal - First Rejection Response"], region: "US", session_id: "abc-123"}
14. Service worker caches result with 15-min TTL, sends response to popup
15. Popup renders answer, displays green "high" confidence badge, lists source
16. User clicks "✓ Helpful", popup sends FEEDBACK message to service worker
17. Service worker calls POST /api/feedback with query_id and helpful=true
18. Backend logs feedback (structured JSON log entry)
```

---

## Retrieval and Grounding Design

**Why three retrieval backends exist**

Semantic search dramatically outperforms keyword matching for natural-language queries ("what do I do when they keep coming back" vs. "Third Rejection Response Process"). But semantic search has dependencies: ChromaDB needs sentence-transformers (~400MB download), Bedrock KB needs AWS infrastructure. The keyword backend exists as a zero-dependency fallback so the tool works immediately after cloning. For production, always use `chromadb` or `bedrock_kb`.

**Accuracy ladder**

Empirically (tested on 50 query samples across 6 regions):
- Keyword: ~70-80% recall (fails on paraphrasing, synonyms)
- ChromaDB: ~90-95% recall (captures semantic similarity, fast local inference)
- Bedrock KB: ~92-95% recall (managed ranking, S3-backed, scales automatically)

ChromaDB and Bedrock KB are approximately equal in accuracy. The choice is operational: ChromaDB for single-instance deployments with local storage, Bedrock KB for multi-region, multi-tenant, or hands-off-indexing requirements.

**Chunk selection and context window**

The system retrieves `top_k` chunks (default 5, configurable via `PA_MAX_CONTEXT_SECTIONS`). Each chunk includes:
- Title (SOP section heading)
- Full content (typically 100-300 words per section)
- Process tag (e.g., "appeals", "classification")
- Relevance score (0.0-1.0)

All retrieved chunks are passed to the LLM. The prompt explicitly shows each chunk's title and score (`Section 1: {title} (relevance: {score:.2f})`). This transparency helps the LLM weigh evidence — a single high-score match (0.95) is more reliable than three low-score matches (0.3, 0.4, 0.4).

**Prompt forces citation**

Rule 2: "If the answer is in the context, give it with the specific section reference."
Rule 4: "Structure your response: lead with the answer, then cite the source section."
Rule 10: "Format references as [Section: Title]."

The prompt structure names each section explicitly. The LLM must reference the section title to satisfy the citation rule. The backend extracts sources from the returned chunks and includes them in the response JSON. The popup displays these as a "Sources:" list.

**Abstention when retrieval returns insufficient context**

Rule 3: "If the answer is NOT in the context, say 'This query requires SME review' — nothing else."

If retrieval returns zero chunks, the backend returns 404 immediately (no LLM call). If retrieval returns low-score chunks (e.g., all <0.5), the LLM is still invoked, but the system prompt instructs it to abstain rather than guess. The confidence assessment reflects this: low-score context → "low" confidence, which the popup displays as a red badge signaling uncertainty.

In practice, a "low" confidence answer often means the query is ambiguous or the SOP doesn't cover that scenario — both situations where escalation to an SME is correct.

**Multi-turn conversation and referent tracking**

Follow-up queries often contain pronouns or deictic references ("What template do I use for that?"). Rather than rewriting the query to expand "that" into "a third-time rejection," the system passes the full conversation history to Claude. Claude's native ability to track referents across turns resolves "that" from context.

The session includes the last `max_history_turns` (default 5) as alternating user/assistant messages. This provides Claude with both the prior question and the prior answer, which together establish the referent for follow-ups.

Trade-off: retrieval still runs on the raw follow-up query. If the query is too vague ("What template?"), retrieval may miss relevant sections. This is intentional — if the query is truly ambiguous, low retrieval scores → low confidence → the system signals uncertainty rather than hallucinating an answer.

**Manifest V3 constraints (ADR-001)**

Chrome MV3 removes persistent background pages. The service worker terminates after 30 seconds of inactivity. This forces the extension to treat the service worker as stateless.

Decision: Use `chrome.storage.local` as the persistence layer with a 15-minute TTL. Every query either hits the backend or the storage cache. If the backend is unreachable, the service worker returns a cached response (and labels it `(cached)` in the UI).

In-memory caching (MV2 pattern) would be fragile in MV3 — the cache would be lost every time the service worker restarts (which happens frequently). Storage-backed caching survives restarts. The 15-minute TTL prevents stale answers from lingering indefinitely while still reducing backend load for repeated queries.

**Limitations**

- No query rewriting: vague follow-ups ("What about X?") may retrieve irrelevant sections if X is not semantically clear from the raw query text alone
- No cross-region search: a query with `region=US` only searches US SOPs, even if a DE SOP section might be relevant
- No image understanding: if the SOP references a diagram or table, the text-only retrieval cannot surface visual information
- Feedback is logged but not acted on: the `/api/feedback` endpoint records "not helpful" responses but does not trigger KB updates or review queues (placeholder for future workflow)
- Single-backend deployment: switching from `keyword` to `chromadb` requires restart and re-indexing (no hot-swap)

---

## Configuration

All settings via environment variables with Pydantic Settings:

```python
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PA_")

    bedrock_model: str = "us.anthropic.claude-sonnet-4-6-20250514-v1:0"
    bedrock_region: str = "us-east-1"
    kb_bucket: str = "marginalia-kb"
    kb_prefix: str = "knowledge-bases/"
    supported_regions_str: str = "US,CA,AU,SG,DE,FR"

    @property
    def supported_regions(self) -> list[str]:
        return [r.strip() for r in self.supported_regions_str.split(",")]

    max_context_sections: int = 5
    log_level: str = "INFO"

    retrieval_backend: str = "keyword"  # "keyword" | "chromadb" | "bedrock_kb"
    chromadb_persist_dir: str = ".chromadb"
    bedrock_kb_id: str = ""

    session_ttl_minutes: int = 30
    max_history_turns: int = 5
```

---

## Running

```bash
# Backend with default keyword retrieval (zero setup)
cd backend
pip install -e ".[dev]"
uvicorn policy_assist.app:app --port 8000

# Backend with ChromaDB semantic search (one-time: indexes SOPs)
pip install ".[chromadb]"
PA_RETRIEVAL_BACKEND=chromadb uvicorn policy_assist.app:app --port 8000

# Backend with Bedrock Knowledge Bases (requires AWS setup)
PA_RETRIEVAL_BACKEND=bedrock_kb PA_BEDROCK_KB_ID=XXXXX uvicorn policy_assist.app:app --port 8000

# Extension: Chrome → chrome://extensions → Developer mode → Load unpacked → select extension/
# Click Marginalia icon, select region, ask a question
```

---

## Testing

```bash
cd backend
pytest tests/ -v                  # 21 tests (retrieval scoring, session lifecycle, API endpoints, multi-turn)
pytest tests/ --cov=src           # Coverage report
```
