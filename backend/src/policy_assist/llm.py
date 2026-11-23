import json
import logging
from dataclasses import dataclass

import boto3

from .config import settings
from .retrieval.base import RetrievedChunk

logger = logging.getLogger("policy_assist")

SYSTEM_PROMPT = """You are a compliance operations assistant. You answer associate queries using ONLY the provided SOP context. Follow these rules exactly:

1. Answer directly. No apologies, no hedging, no "I think" or "It seems."
2. If the answer is in the context, give it with the specific section reference.
3. If the answer is NOT in the context, say "This query requires SME review" — nothing else.
4. Structure your response: lead with the answer, then cite the source section.
5. Use the region-specific guidance when available (procedures vary by marketplace).
6. If multiple SOPs apply, list them in priority order.
7. Never invent procedures that aren't in the provided context.
8. Keep responses under 200 words. Associates need quick answers, not essays.
9. If the query is ambiguous, ask ONE clarifying question instead of guessing.
10. Format action steps as numbered lists. Format references as [Section: Title].
11. If the query is in a non-English language, respond in the same language but reference the English SOP section names."""


@dataclass
class Answer:
    text: str
    confidence: str
    sources: list[str]


class QueryEngine:
    def __init__(self):
        self.client = boto3.client("bedrock-runtime", region_name=settings.bedrock_region)

    def answer(
        self,
        query: str,
        context: list[RetrievedChunk],
        region: str,
        history: list[dict] | None = None,
    ) -> Answer:
        messages = []
        if history:
            messages.extend(history)

        user_prompt = self._build_prompt(query, context, region)
        messages.append({"role": "user", "content": user_prompt})

        try:
            response = self.client.invoke_model(
                modelId=settings.bedrock_model,
                body=json.dumps(
                    {
                        "anthropic_version": "bedrock-2023-05-31",
                        "max_tokens": 500,
                        "temperature": 0,
                        "system": [
                            {
                                "type": "text",
                                "text": SYSTEM_PROMPT,
                                "cache_control": {"type": "ephemeral"},
                            }
                        ],
                        "messages": messages,
                    }
                ),
                contentType="application/json",
            )
            body = json.loads(response["body"].read())
            text = body["content"][0]["text"]
        except Exception as e:
            logger.error(f"Bedrock call failed: {e}")
            return Answer(
                text="Service temporarily unavailable. Please try again.",
                confidence="none",
                sources=[],
            )

        sources = [chunk.title for chunk in context]
        confidence = self._assess_confidence(context)

        return Answer(text=text, confidence=confidence, sources=sources)

    def _build_prompt(self, query: str, context: list[RetrievedChunk], region: str) -> str:
        parts = [f"REGION: {region}", f"QUERY: {query}", "", "RELEVANT SOP SECTIONS:"]
        for i, chunk in enumerate(context, 1):
            parts.append(f"\n--- Section {i}: {chunk.title} (relevance: {chunk.score:.2f}) ---")
            parts.append(chunk.content)
        parts.append("\nAnswer the query using ONLY the above context.")
        return "\n".join(parts)

    def _assess_confidence(self, context: list[RetrievedChunk]) -> str:
        if not context:
            return "low"
        avg_score = sum(c.score for c in context) / len(context)
        if avg_score > 0.8 and len(context) >= 3:
            return "high"
        elif avg_score > 0.5 or len(context) >= 2:
            return "medium"
        return "low"
