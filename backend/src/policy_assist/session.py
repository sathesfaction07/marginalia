import time
import uuid
from dataclasses import dataclass, field


@dataclass
class Turn:
    query: str
    answer: str
    sources: list[str]
    timestamp: float = field(default_factory=time.time)


@dataclass
class Session:
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    turns: list[Turn] = field(default_factory=list)
    region: str = "US"
    created_at: float = field(default_factory=time.time)

    def add_turn(self, query: str, answer: str, sources: list[str]) -> None:
        self.turns.append(Turn(query=query, answer=answer, sources=sources))

    def get_history(self, max_turns: int = 5) -> list[dict]:
        recent = self.turns[-max_turns:]
        return [{"role": "user", "content": t.query} for t in recent] + [
            {"role": "assistant", "content": t.answer} for t in recent
        ]

    def get_history_messages(self, max_turns: int = 5) -> list[dict]:
        messages = []
        for turn in self.turns[-max_turns:]:
            messages.append({"role": "user", "content": turn.query})
            messages.append({"role": "assistant", "content": turn.answer})
        return messages


class SessionStore:
    def __init__(self, ttl_minutes: int = 30):
        self._sessions: dict[str, Session] = {}
        self._ttl = ttl_minutes * 60

    def get_or_create(self, session_id: str | None, region: str = "US") -> Session:
        self._cleanup()
        if session_id and session_id in self._sessions:
            return self._sessions[session_id]
        session = Session(region=region)
        self._sessions[session.session_id] = session
        return session

    def get(self, session_id: str) -> Session | None:
        self._cleanup()
        return self._sessions.get(session_id)

    def _cleanup(self) -> None:
        now = time.time()
        expired = [sid for sid, s in self._sessions.items() if now - s.created_at > self._ttl]
        for sid in expired:
            del self._sessions[sid]
