import logging

from .base import RetrievalBackend, RetrievedChunk

logger = logging.getLogger("policy_assist")


class ChromaDBBackend(RetrievalBackend):
    def __init__(
        self, persist_dir: str = ".chromadb", embedding_model: str = "all-MiniLM-L6-v2", **kwargs
    ):
        import chromadb
        from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction

        self.embedding_fn = SentenceTransformerEmbeddingFunction(model_name=embedding_model)
        self.client = chromadb.PersistentClient(path=persist_dir)
        self._collections: dict[str, any] = {}

    def search(
        self, query: str, region: str, process: str = "", top_k: int = 5
    ) -> list[RetrievedChunk]:
        collection = self._get_collection(region)
        if collection is None or collection.count() == 0:
            return []

        where_filter = {"process": process} if process else None
        results = collection.query(query_texts=[query], n_results=top_k, where=where_filter)

        chunks = []
        for i, _doc_id in enumerate(results["ids"][0]):
            metadata = results["metadatas"][0][i]
            content = results["documents"][0][i]
            distance = results["distances"][0][i] if results.get("distances") else 0

            chunks.append(
                RetrievedChunk(
                    title=metadata.get("title", ""),
                    content=content,
                    process=metadata.get("process", ""),
                    score=1.0 - distance,
                )
            )

        return chunks

    def index_documents(self, region: str, documents: list[dict]) -> int:
        collection = self._get_or_create_collection(region)

        ids = [f"{region}_{i}" for i in range(len(documents))]
        texts = [doc["content"] for doc in documents]
        metadatas = [
            {"title": doc["title"], "process": doc.get("process", "")} for doc in documents
        ]

        collection.upsert(ids=ids, documents=texts, metadatas=metadatas)
        logger.info(f"Indexed {len(documents)} documents for region {region}")
        return len(documents)

    def _get_collection(self, region: str):
        name = f"kb_{region.lower()}"
        try:
            return self.client.get_collection(name=name, embedding_function=self.embedding_fn)
        except Exception:
            return None

    def _get_or_create_collection(self, region: str):
        name = f"kb_{region.lower()}"
        return self.client.get_or_create_collection(name=name, embedding_function=self.embedding_fn)
