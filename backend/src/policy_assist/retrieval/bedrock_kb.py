import logging

import boto3

from .base import RetrievalBackend, RetrievedChunk

logger = logging.getLogger("policy_assist")


class BedrockKBBackend(RetrievalBackend):
    def __init__(self, knowledge_base_id: str = "", region: str = "us-east-1", **kwargs):
        self.kb_id = knowledge_base_id
        self.client = boto3.client("bedrock-agent-runtime", region_name=region)

    def search(
        self, query: str, region: str, process: str = "", top_k: int = 5
    ) -> list[RetrievedChunk]:
        if not self.kb_id:
            logger.error("Bedrock KB ID not configured")
            return []

        try:
            response = self.client.retrieve(
                knowledgeBaseId=self.kb_id,
                retrievalQuery={"text": query},
                retrievalConfiguration={"vectorSearchConfiguration": {"numberOfResults": top_k}},
            )
        except Exception as e:
            logger.error(f"Bedrock KB retrieval failed: {e}")
            return []

        chunks = []
        for result in response.get("retrievalResults", []):
            content = result.get("content", {}).get("text", "")
            metadata = result.get("metadata", {})
            score = result.get("score", 0.0)

            chunks.append(
                RetrievedChunk(
                    title=metadata.get("title", content[:50]),
                    content=content,
                    process=metadata.get("process", ""),
                    score=score,
                    source_file=result.get("location", {}).get("s3Location", {}).get("uri", ""),
                )
            )

        return chunks

    def index_documents(self, region: str, documents: list[dict]) -> int:
        logger.info(
            "Bedrock KB indexing is managed via S3 data source sync — not supported via this interface"
        )
        return 0
