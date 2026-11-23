from policy_assist.session import Session, SessionStore


class TestSession:
    def test_add_turn(self):
        s = Session()
        s.add_turn("how do I handle this?", "Do X then Y.", ["Section A"])
        assert len(s.turns) == 1
        assert s.turns[0].query == "how do I handle this?"

    def test_get_history_messages(self):
        s = Session()
        s.add_turn("q1", "a1", [])
        s.add_turn("q2", "a2", [])
        messages = s.get_history_messages(max_turns=5)
        assert len(messages) == 4
        assert messages[0] == {"role": "user", "content": "q1"}
        assert messages[1] == {"role": "assistant", "content": "a1"}

    def test_history_respects_max_turns(self):
        s = Session()
        for i in range(10):
            s.add_turn(f"q{i}", f"a{i}", [])
        messages = s.get_history_messages(max_turns=2)
        assert len(messages) == 4


class TestSessionStore:
    def test_create_new(self):
        store = SessionStore()
        s = store.get_or_create(None, "US")
        assert s.session_id
        assert s.region == "US"

    def test_retrieve_existing(self):
        store = SessionStore()
        s1 = store.get_or_create(None, "US")
        s2 = store.get_or_create(s1.session_id, "US")
        assert s1.session_id == s2.session_id

    def test_unknown_id_creates_new(self):
        store = SessionStore()
        s = store.get_or_create("nonexistent-id", "US")
        assert s.session_id != "nonexistent-id"
