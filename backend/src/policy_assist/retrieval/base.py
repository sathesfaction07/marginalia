from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class RetrievedChunk:
    title: str
    content: str
    process: str
    score: float
    source_file: str = ""


class RetrievalBackend(ABC):
    @abstractmethod
    def search(
        self, query: str, region: str, process: str = "", top_k: int = 5
    ) -> list[RetrievedChunk]: ...

    @abstractmethod
    def index_documents(self, region: str, documents: list[dict]) -> int: ...
