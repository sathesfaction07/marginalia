import json
import logging
from pathlib import Path

from .base import RetrievalBackend, RetrievedChunk

logger = logging.getLogger("policy_assist")


class KeywordBackend(RetrievalBackend):
    def __init__(self, kb_path: Path | None = None, **kwargs):
        self.kb_path = (
            kb_path or Path(__file__).parent.parent.parent.parent / "data" / "knowledge_bases"
        )
        self._cache: dict[str, list[dict]] = {}

    def search(
        self, query: str, region: str, process: str = "", top_k: int = 5
    ) -> list[RetrievedChunk]:
        documents = self._load_region(region)
        if not documents:
            return []

        if process:
            filtered = [d for d in documents if d.get("process", "").lower() == process.lower()]
            documents = filtered or documents

        query_terms = set(query.lower().split())
        scored = []

        for doc in documents:
            title_terms = set(doc.get("title", "").lower().split())
            keywords = set(doc.get("keywords", []))
            content_terms = set(doc.get("content", "").lower().split()[:200])

            score = (
                (len(query_terms & title_terms) * 3)
                + (len(query_terms & keywords) * 5)
                + (len(query_terms & content_terms) * 1)
            )
            if score > 0:
                scored.append((doc, score))

        scored.sort(key=lambda x: x[1], reverse=True)
        return [
            RetrievedChunk(
                title=doc["title"],
                content=doc["content"],
                process=doc.get("process", ""),
                score=score,
            )
            for doc, score in scored[:top_k]
        ]

    def index_documents(self, region: str, documents: list[dict]) -> int:
        self._cache[region] = documents
        return len(documents)

    def _load_region(self, region: str) -> list[dict]:
        if region in self._cache:
            return self._cache[region]

        kb_file = self.kb_path / f"{region.lower()}.json"
        if not kb_file.exists():
            return []

        with open(kb_file) as f:
            documents = json.load(f)

        self._cache[region] = documents
        return documents
