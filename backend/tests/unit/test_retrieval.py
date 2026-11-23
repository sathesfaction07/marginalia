from pathlib import Path

from policy_assist.retrieval.keyword import KeywordBackend

KB_PATH = Path(__file__).parent.parent.parent / "data" / "knowledge_bases"


class TestKeywordBackend:
    def setup_method(self):
        self.backend = KeywordBackend(kb_path=KB_PATH)

    def test_finds_relevant_section(self):
        results = self.backend.search("merchant appeal first rejection", "US")
        assert len(results) > 0
        assert results[0].title == "Merchant Appeal - First Rejection Response"

    def test_empty_for_unknown_region(self):
        results = self.backend.search("anything", "XX")
        assert results == []

    def test_process_filter(self):
        results = self.backend.search("product classification age", "US", process="classification")
        for r in results:
            assert r.process == "classification"

    def test_respects_top_k(self):
        results = self.backend.search("product merchant image", "US", top_k=2)
        assert len(results) <= 2

    def test_irrelevant_query_returns_empty(self):
        results = self.backend.search("xyzzy quantum entanglement", "US")
        assert results == []

    def test_scores_are_positive(self):
        results = self.backend.search("escalation criteria sme", "US")
        assert all(r.score > 0 for r in results)

    def test_index_documents(self):
        docs = [
            {"title": "Test", "content": "test content", "keywords": ["test"], "process": "general"}
        ]
        count = self.backend.index_documents("TEST", docs)
        assert count == 1
        results = self.backend.search("test content", "TEST")
        assert len(results) == 1
