"""应用配置：环境变量优先，其次 config.yaml，最后默认值。"""

from __future__ import annotations

import logging
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
    # 单次生成的 token 上限。推理模型（如 MiniMax-M3 系列）会把预算花在
    # reasoning 上，正文预算不足时返回空内容——默认给足。
    llm_max_tokens: int = 4000

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


# 只允许从环境变量 / .env 读取的敏感项。
#
# 这些字段**禁止**从 config.yaml 覆盖——config.yaml 虽不入库，但仍可能被人
# 复制、贴到工单或误提交。密钥只允许存在于机器环境变量（或 .env）里。
ENV_ONLY_FIELDS = {"llm_api_key", "jwt_secret"}


def _env_defined_keys() -> set[str]:
    """返回在环境变量或 .env 中**显式设置过**的配置项名（小写，不含前缀）。

    用于实现「环境变量优先于 config.yaml」：凡是环境里已经给过值的项，
    yaml 里的同名项一律忽略。
    """
    keys: set[str] = set()
    for name in os.environ:
        if name.startswith("CGA_"):
            keys.add(name[4:].lower())
    for candidate in (BASE_DIR / ".env", REPO_ROOT / ".env"):
        if not candidate.exists():
            continue
        try:
            content = candidate.read_text(encoding="utf-8")
        except OSError:  # pragma: no cover - 读不到就当没有
            continue
        for line in content.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name = line.split("=", 1)[0].strip()
            if name.startswith("CGA_"):
                keys.add(name[4:].lower())
    return keys


@lru_cache
def get_settings() -> Settings:
    """装配配置：**环境变量 / .env > config.yaml > 默认值**。

    注意：pydantic-settings 会在实例化时读取环境变量与 .env，
    因此这里只在「环境里没有给过」的项上应用 yaml 覆盖，
    才能保证环境变量真正优先（否则 yaml 会反过来盖掉环境变量）。
    """
    settings = Settings()
    overrides = _load_yaml_overrides()
    env_keys = _env_defined_keys()
    for key, value in overrides.items():
        if not hasattr(settings, key) or value is None:
            continue
        if key in ENV_ONLY_FIELDS:
            logging.getLogger(__name__).warning(
                "config.yaml 中的 %s 已被忽略：敏感项只允许通过环境变量或 .env 提供", key
            )
            continue
        if key in env_keys:
            continue  # 环境变量优先
        setattr(settings, key, value)
    if os.getenv("CGA_DATABASE_URL"):
        settings.database_url = os.environ["CGA_DATABASE_URL"]
    return settings


settings = get_settings()
