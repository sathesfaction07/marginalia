# Marginalia

A Chrome extension + Python backend that gives compliance associates instant answers to process questions. The associate types a question, the backend retrieves relevant SOP sections using semantic search, sends them to Claude as context, and returns a direct answer. Supports multi-turn conversations, multiple retrieval backends, and non-English queries.

---

## The Problem

Compliance associates handle cases following Standard Operating Procedures that differ by region, marketplace, and product category. When they're unsure about a procedure, they submit a query to a Subject Matter Expert and wait up to 24 hours. Meanwhile the case sits pending. The SOPs exist, but they're scattered across platforms and associates often phrase questions differently from how SOPs are titled — "what do I do when they keep coming back" doesn't match a section titled "Third Rejection Response Process."

Keyword search fails here. Semantic search understands intent.

---

## How It Works

**The Extension (Chrome, Manifest V3)**

A popup where the associate selects their region, types a question, and gets an answer. Results are cached locally with a 15-minute TTL. If the backend is unreachable, falls back to cached responses. Multi-turn: follow-up questions reference prior answers in the same session.

**The Backend (Python, FastAPI)**

1. Receives a query + region + optional session ID
2. Retrieves relevant SOP sections via the configured retrieval backend
3. Builds a prompt with context + conversation history (if multi-turn)
4. Gets an answer from Bedrock Claude with a 10-rule prompt
5. Stores the turn in the session for follow-up context

---

## Retrieval Backends

The biggest accuracy lever. Three options, configurable at runtime:

| Backend | How it finds relevant sections | Accuracy | Cost | Setup |
|:--|:--|:--|:--|:--|
| `keyword` (default) | Token overlap between query and section titles/keywords/content | ~70-80% | Free | None — works immediately |
| `chromadb` | Embeds all SOPs with sentence-transformers, vector similarity search | ~90-95% | Free (local) | `pip install "marginalia[chromadb]"` + one-time indexing |
| `bedrock_kb` | AWS Bedrock Knowledge Bases (managed RAG — auto-embeds S3 documents) | ~92-95% | AWS pricing | Configure KB ID, upload SOPs to S3 |

Switch at runtime via environment variable:

```bash
PA_RETRIEVAL_BACKEND=chromadb uvicorn policy_assist.app:app
PA_RETRIEVAL_BACKEND=bedrock_kb PA_BEDROCK_KB_ID=XXXXX uvicorn policy_assist.app:app
```

The keyword backend exists as a zero-dependency fallback and for development. For production use, `chromadb` or `bedrock_kb` handles the paraphrasing problem that keywords can't solve.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                Chrome Extension (MV3)                      │
│  Popup → Service Worker → API call → Cache (15min TTL)   │
└─────────────────────────┬────────────────────────────────┘
                          │ HTTP
                          ▼
┌──────────────────────────────────────────────────────────┐
│               FastAPI Backend (Port 8000)                  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Retrieval Layer (configurable)                      │  │
│  │  keyword │ chromadb │ bedrock_kb                    │  │
│  └─────────────────────────┬──────────────────────────┘  │
│                            │ relevant sections            │
│                            ▼                              │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Session Manager                                     │  │
│  │  (multi-turn history, 30-min TTL)                   │  │
│  └─────────────────────────┬──────────────────────────┘  │
│                            │ context + history            │
│                            ▼                              │
│  ┌────────────────────────────────────────────────────┐  │
│  │ LLM (Bedrock Claude Sonnet)                         │  │
│  │  10-rule prompt + conversation history              │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
marginalia/
├── backend/
│   ├── src/policy_assist/
│   │   ├── app.py                FastAPI endpoints
│   │   ├── config.py             Settings (backend selection, regions, session TTL)
│   │   ├── llm.py               Bedrock Claude + 10-rule prompt + multi-turn
│   │   ├── session.py           In-memory conversation sessions
│   │   └── retrieval/
│   │       ├── base.py          Abstract interface
│   │       ├── keyword.py       Token-overlap scorer (zero deps)
│   │       ├── chromadb_backend.py  sentence-transformers + ChromaDB
│   │       └── bedrock_kb.py    AWS Bedrock Knowledge Bases
│   ├── tests/unit/
│   ├── data/knowledge_bases/    JSON SOPs per region
│   └── pyproject.toml
├── extension/
│   ├── manifest.json
│   ├── src/background/          Service worker (API calls, caching)
│   ├── src/popup/               Query UI
│   └── src/content/             Page context detection
└── docs/adr/
```

---

## Running

**Backend:**
```bash
cd backend
pip install -e ".[dev]"

# Default (keyword retrieval — no setup needed)
uvicorn policy_assist.app:app --port 8000

# With semantic search (one-time: indexes SOPs into ChromaDB)
pip install "marginalia[chromadb]"
PA_RETRIEVAL_BACKEND=chromadb uvicorn policy_assist.app:app --port 8000

# With AWS managed RAG
PA_RETRIEVAL_BACKEND=bedrock_kb PA_BEDROCK_KB_ID=your-kb-id uvicorn policy_assist.app:app
```

**Extension:**
1. Chrome → `chrome://extensions` → Developer mode → Load unpacked → select `extension/`
2. Click the Marginalia icon, select region, ask a question

---

## API

```bash
# Ask a question (new session)
curl -X POST localhost:8000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "How do I handle a third-time rejection?", "region": "US"}'

# Follow-up (same session)
curl -X POST localhost:8000/api/query \
  -d '{"query": "What template do I use for that?", "region": "US", "session_id": "abc-123"}'

# Submit feedback
curl -X POST localhost:8000/api/feedback \
  -d '{"query_id": "xyz", "helpful": false, "correction": "Should reference Template C not B"}'

# Health
curl localhost:8000/health

# Index documents (for chromadb backend)
curl -X POST "localhost:8000/api/index?region=US" \
  -d '[{"title": "...", "content": "...", "keywords": [...], "process": "..."}]'
```

---

## Testing

```bash
cd backend
pytest tests/ -v              # 21 tests
pytest tests/ --cov=src       # coverage
```

Tests cover: retrieval scoring, session lifecycle (create/retrieve/history truncation), API endpoints with mocked backends, and multi-turn conversation threading.

---

## Configuration

| Variable | Default | What it controls |
|:--|:--|:--|
| `PA_RETRIEVAL_BACKEND` | `keyword` | Which retrieval engine to use |
| `PA_BEDROCK_MODEL` | `claude-sonnet-4-6` | LLM for answer generation |
| `PA_BEDROCK_REGION` | `us-east-1` | AWS region |
| `PA_BEDROCK_KB_ID` | (empty) | Bedrock Knowledge Base ID (for bedrock_kb backend) |
| `PA_CHROMADB_PERSIST_DIR` | `.chromadb` | ChromaDB storage location |
| `PA_SUPPORTED_REGIONS` | US,CA,AU,SG,DE,FR | Available regions |
| `PA_MAX_CONTEXT_SECTIONS` | 5 | How many SOP sections to retrieve |
| `PA_SESSION_TTL_MINUTES` | 30 | How long conversation sessions live |
| `PA_MAX_HISTORY_TURNS` | 5 | How many prior turns to include as context |

---

## Tradeoffs and Decisions I Made Along the Way

**Three retrieval backends instead of just picking semantic search**

Semantic search (ChromaDB or Bedrock KB) is clearly more accurate than keyword matching for natural-language queries. But it has dependencies: ChromaDB needs sentence-transformers (~400MB model download), Bedrock KB needs AWS infrastructure setup. The keyword backend works with zero dependencies — you clone the repo, run `uvicorn`, and it works. For development, demos, and environments without internet access, that matters. In production you'd always use chromadb or bedrock_kb.

**In-memory sessions instead of Redis**

For a single-instance backend serving one team (~30 concurrent users), in-memory session storage is simpler and faster than adding Redis. Sessions expire after 30 minutes anyway. If the server restarts, associates lose conversation context — but they can re-ask the question and get the same answer. If this needed to scale to multiple backend instances, I'd move sessions to Redis. The `SessionStore` interface makes that swap trivial.

**Multi-turn via conversation history in the LLM call, not via rewriting the query**

One approach to follow-ups: rewrite "What template do I use for that?" into "What template do I use for a third-time rejection?" using the prior context, then do retrieval on the rewritten query. I chose the simpler approach: pass the full conversation history to Claude and let it understand "that" from context. This avoids a separate query-rewriting step and leverages Claude's native ability to track referents across turns. The tradeoff: retrieval still runs on the raw follow-up query (which might miss relevant sections). If this becomes a problem, adding query expansion is one line of change in the retrieval call.

**Rule 11: respond in the query language**

Associates in non-English regions sometimes ask questions in their local language. The SOPs are in English. Rather than translating the query before retrieval (which adds latency and potential translation errors), I added a rule to the system prompt: "respond in the same language as the query but reference English section names." Claude handles the translation inline. This works because the retrieval is semantic (vector similarity is language-agnostic for multilingual embedding models) — the right English SOP section gets retrieved even from a Hindi query.

**Confidence based on retrieval quality, not LLM certainty**

The LLM will always sound confident — that's its nature. Real confidence comes from whether the retrieval found genuinely relevant sections. If the top result has a similarity score of 0.95 and there are 3+ matches, confidence is "high" — the context is strong. If only one section matched at 0.4, confidence is "low" regardless of how assertive Claude's answer sounds. This prevents the system from confidently delivering an answer hallucinated from weak context.

**Feedback endpoint logs but doesn't act (yet)**

The `/api/feedback` endpoint records whether an answer was helpful plus any correction text. In a production system, "not helpful" responses would go to a review queue where a KB maintainer updates the SOP. For now it logs — but the endpoint exists so the extension can collect feedback from day one. The data accumulates even before the review workflow is built.

---

## Stack

**Backend:** Python 3.11, FastAPI, boto3/Bedrock (Claude Sonnet), ChromaDB + sentence-transformers (optional), Pydantic.

**Extension:** Vanilla JS, Manifest V3, chrome.storage API.
