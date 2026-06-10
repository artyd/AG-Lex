"""AG Lex backend settings.

Loads `.env` once via python-dotenv, exposes a typed Settings singleton via
`get_settings()`. Defaults keep dev usable without a fully populated .env;
required secrets (API_KEY, JWT_SECRET) intentionally have no default so the
app fails loud if they are missing in production.
"""
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(BASE_DIR / ".env"), extra="ignore")

    API_KEY: str = Field(default="", description="Anthropic API key")
    MODEL_NAME: str = Field(default="claude-sonnet-4-6", description="Claude model id; see docs.claude.com")
    DB_PATH: str = Field(default=str(BASE_DIR / "database" / "legal.sqlite"))
    JWT_SECRET: str = Field(default="dev-only-change-me")
    EMBED_MODEL: str = Field(default="paraphrase-multilingual-MiniLM-L12-v2")

    FRONTEND_DIR: str = Field(
        default=str(BASE_DIR.parent / "dist"),
        description="Folder containing built frontend (Vite dist/). FastAPI serves it at /.",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
