from .base import RetrievalBackend, RetrievedChunk
from .bedrock_kb import BedrockKBBackend
from .chromadb_backend import ChromaDBBackend
from .keyword import KeywordBackend

BACKENDS = {
    "keyword": KeywordBackend,
    "chromadb": ChromaDBBackend,
    "bedrock_kb": BedrockKBBackend,
}


def get_retrieval_backend(name: str, **kwargs) -> RetrievalBackend:
    cls = BACKENDS.get(name)
    if not cls:
        available = ", ".join(BACKENDS.keys())
        raise ValueError(f"Unknown retrieval backend: {name}. Available: {available}")
    return cls(**kwargs)

# Re-exported: this module IS the package's public surface.
__all__ = [
    "BedrockKBBackend",
    "ChromaDBBackend",
    "KeywordBackend",
    "RetrievalBackend",
    "RetrievedChunk",
]
