from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PA_")

    bedrock_model: str = "us.anthropic.claude-sonnet-4-6-20250514-v1:0"
    bedrock_region: str = "us-east-1"
    kb_bucket: str = "marginalia-kb"
    kb_prefix: str = "knowledge-bases/"
    supported_regions_str: str = "US,CA,AU,SG,DE,FR"

    @property
    def supported_regions(self) -> list[str]:
        return [r.strip() for r in self.supported_regions_str.split(",")]

    max_context_sections: int = 5
    log_level: str = "INFO"

    retrieval_backend: str = "keyword"  # "keyword" | "chromadb" | "bedrock_kb"
    chromadb_persist_dir: str = ".chromadb"
    bedrock_kb_id: str = ""

    session_ttl_minutes: int = 30
    max_history_turns: int = 5


settings = Settings()
