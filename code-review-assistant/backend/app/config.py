from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "sqlite+aiosqlite:///./data/code_review.db"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-20250514"
    anthropic_base_url: str = ""
    anthropic_auth_token: str = ""
    feishu_webhook_url: str = ""
    git_executable: str = "git"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    admin_username: str = ""
    admin_password: str = ""
    api_key_type: str = ""  # "cursor" or "claude", set at login

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
