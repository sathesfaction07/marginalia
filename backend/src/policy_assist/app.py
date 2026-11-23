import logging
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import settings
from .llm import QueryEngine
from .retrieval import get_retrieval_backend
from .session import SessionStore

logging.basicConfig(
    level=settings.log_level,
    format='{"time":"%(asctime)s","level":"%(levelname)s","module":"%(module)s","msg":"%(message)s"}',
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("policy_assist")

app = FastAPI(title="Marginalia API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

retrieval = get_retrieval_backend(
    settings.retrieval_backend,
    kb_path=None,
    persist_dir=settings.chromadb_persist_dir,
    knowledge_base_id=settings.bedrock_kb_id,
    region=settings.bedrock_region,
)
query_engine = QueryEngine()
sessions = SessionStore(ttl_minutes=settings.session_ttl_minutes)

START_TIME = time.time()
request_count = 0


class QueryRequest(BaseModel):
    query: str
    region: str = "US"
    process: str = ""
    session_id: str | None = None


class FeedbackRequest(BaseModel):
    query_id: str
    session_id: str = ""
    helpful: bool
    correction: str = ""


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "uptime_seconds": round(time.time() - START_TIME, 1),
        "requests_served": request_count,
        "retrieval_backend": settings.retrieval_backend,
        "supported_regions": settings.supported_regions,
    }


@app.post("/api/query")
async def handle_query(req: QueryRequest):
    global request_count
    request_count += 1

    if req.region not in settings.supported_regions:
        raise HTTPException(400, f"Unsupported region: {req.region}")

    if not req.query.strip():
        raise HTTPException(400, "Query cannot be empty")

    logger.info(
        f"Query: region={req.region} process={req.process} backend={settings.retrieval_backend}"
    )

    session = sessions.get_or_create(req.session_id, req.region)
    context = retrieval.search(
        req.query, req.region, req.process, top_k=settings.max_context_sections
    )

    if not context:
        raise HTTPException(404, "No relevant knowledge base content found for this query")

    history = (
        session.get_history_messages(max_turns=settings.max_history_turns)
        if session.turns
        else None
    )
    answer = query_engine.answer(req.query, context, req.region, history=history)

    session.add_turn(req.query, answer.text, answer.sources)

    return {
        "answer": answer.text,
        "confidence": answer.confidence,
        "sources": answer.sources,
        "region": req.region,
        "session_id": session.session_id,
    }


@app.post("/api/feedback")
async def handle_feedback(req: FeedbackRequest):
    logger.info(
        f"Feedback: query_id={req.query_id} helpful={req.helpful} correction_len={len(req.correction)}"
    )
    # In production: write to DynamoDB/S3 for review queue
    return {"status": "recorded"}


@app.get("/api/regions")
def list_regions():
    return {"regions": settings.supported_regions}


@app.post("/api/index")
async def index_region(region: str, documents: list[dict]):
    if region not in settings.supported_regions:
        raise HTTPException(400, f"Unsupported region: {region}")
    count = retrieval.index_documents(region, documents)
    return {"indexed": count, "region": region}
