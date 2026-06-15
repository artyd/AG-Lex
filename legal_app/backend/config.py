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

    # Phase 4.x — display-PDF pipeline. soffice converts DOCX/XLSX → PDF so
    # the FE can render the original 1-to-1 via PDF.js; the analysis still
    # runs against markdown for token efficiency.
    SOFFICE_PATH: str = Field(
        default="soffice",
        description=(
            "LibreOffice headless converter. Default `soffice` resolves via PATH; "
            "set to an absolute path on hosts where it isn't on PATH "
            "(e.g. /usr/lib/libreoffice/program/soffice)."
        ),
    )
    DISPLAY_PDF_TIMEOUT: float = Field(
        default=30.0,
        description="Hard timeout per single-doc soffice conversion (seconds).",
    )
    MAX_DISPLAY_PDF_BYTES: int = Field(
        default=40 * 1024 * 1024,
        description="Reject rendered PDFs larger than this. Prevents runaway BLOBs.",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
