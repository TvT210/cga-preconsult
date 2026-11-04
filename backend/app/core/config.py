"""应用配置：环境变量优先，其次 config.yaml，最后默认值。"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]  # backend/
REPO_ROOT = BASE_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CGA_", env_file=".env", extra="ignore")

    app_name: str = "老年人就医预问诊与老年综合评估系统"
    api_prefix: str = "/api/v1"
    debug: bool = False

    # 数据层：默认 SQLite 便于本地演示，生产切 PostgreSQL
    database_url: str = ""
    data_dir: str = ""

    # 鉴权
    jwt_secret: str = "cga-dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 720

    # 大模型：mock 模式无需任何 Key，接口与真实模型一致
    llm_provider: str = "mock"  # mock | openai_compatible
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""
    llm_timeout: float = 60.0

    # 匹配引擎权重（可在 matching_rules 表中覆盖）
    core_symptom_weight: float = 3.0
    secondary_symptom_weight: float = 1.0
    history_bonus: float = 15.0
    probability_temperature: float = 10.0
    global_alert_threshold: float = 60.0

    cors_origins: str = "http://127.0.0.1:3000,http://localhost:3000"

    @property
    def data_path(self) -> Path:
        path = Path(self.data_dir) if self.data_dir else BASE_DIR / "data"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def sqlalchemy_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(self.data_path / 'cga.db').as_posix()}"


def _load_yaml_overrides() -> dict[str, Any]:
    """读取仓库根 config.yaml（不入库），用于本地配置覆盖。"""
    for candidate in (REPO_ROOT / "config.yaml", BASE_DIR / "config.yaml"):
        if not candidate.exists():
            continue
        try:
            import yaml  # type: ignore
        except ImportError:  # pragma: no cover - 可选依赖
            return {}
        try:
            data = yaml.safe_load(candidate.read_text(encoding="utf-8")) or {}
        except Exception:  # pragma: no cover - 配置损坏不应阻断启动
            return {}
        return data if isinstance(data, dict) else {}
    return {}


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    overrides = _load_yaml_overrides()
    for key, value in overrides.items():
        if hasattr(settings, key) and value is not None:
            setattr(settings, key, value)
    if os.getenv("CGA_DATABASE_URL"):
        settings.database_url = os.environ["CGA_DATABASE_URL"]
    return settings


settings = get_settings()
