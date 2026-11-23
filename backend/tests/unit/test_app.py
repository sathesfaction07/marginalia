from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from policy_assist.app import app
from policy_assist.llm import Answer
from policy_assist.retrieval.base import RetrievedChunk


@pytest.fixture
def client():
    return TestClient(app)


class TestHealthEndpoint:
    def test_returns_200(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "healthy"
        assert "retrieval_backend" in resp.json()

    def test_includes_supported_regions(self, client):
        resp = client.get("/health")
        assert "US" in resp.json()["supported_regions"]


class TestQueryEndpoint:
    @patch("policy_assist.app.query_engine")
    @patch("policy_assist.app.retrieval")
    def test_valid_query(self, mock_retrieval, mock_engine, client):
        mock_retrieval.search.return_value = [
            RetrievedChunk(title="Test Section", content="content", process="general", score=0.9)
        ]
        mock_engine.answer.return_value = Answer(
            text="Do X.", confidence="high", sources=["Test Section"]
        )

        resp = client.post("/api/query", json={"query": "How?", "region": "US"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["answer"] == "Do X."
        assert "session_id" in data

    @patch("policy_assist.app.query_engine")
    @patch("policy_assist.app.retrieval")
    def test_multi_turn_passes_history(self, mock_retrieval, mock_engine, client):
        mock_retrieval.search.return_value = [
            RetrievedChunk(title="S1", content="c1", process="", score=0.8)
        ]
        mock_engine.answer.return_value = Answer(
            text="First answer.", confidence="high", sources=["S1"]
        )

        resp1 = client.post("/api/query", json={"query": "First question", "region": "US"})
        session_id = resp1.json()["session_id"]

        mock_engine.answer.return_value = Answer(
            text="Follow-up answer.", confidence="medium", sources=["S1"]
        )
        resp2 = client.post(
            "/api/query", json={"query": "Follow up", "region": "US", "session_id": session_id}
        )
        assert resp2.status_code == 200
        assert resp2.json()["session_id"] == session_id
        # Engine should have been called with history on second call
        _, kwargs = mock_engine.answer.call_args
        assert kwargs.get("history") is not None

    def test_empty_query_rejected(self, client):
        resp = client.post("/api/query", json={"query": "", "region": "US"})
        assert resp.status_code == 400

    def test_unsupported_region(self, client):
        resp = client.post("/api/query", json={"query": "test", "region": "XX"})
        assert resp.status_code == 400

    @patch("policy_assist.app.retrieval")
    def test_no_context_returns_404(self, mock_retrieval, client):
        mock_retrieval.search.return_value = []
        resp = client.post("/api/query", json={"query": "unknown topic", "region": "US"})
        assert resp.status_code == 404


class TestRegionsEndpoint:
    def test_lists_regions(self, client):
        resp = client.get("/api/regions")
        assert "US" in resp.json()["regions"]
