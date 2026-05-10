from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any


_ROOT = Path(__file__).resolve().parent.parent.parent
_LOG_DIR = _ROOT / "runtime-logs" / "reviews"


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def write_review_event(record_type: str, record_id: int, stage: str, payload: dict[str, Any] | None = None) -> None:
    """Best-effort local troubleshooting logs, one file per record."""
    try:
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        safe_type = "cross" if record_type == "cross" else "single"
        f = _LOG_DIR / f"{safe_type}-{record_id}.log"
        event = {
            "time": _now(),
            "type": safe_type,
            "id": record_id,
            "stage": stage,
            "payload": payload or {},
        }
        with f.open("a", encoding="utf-8") as fp:
            fp.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception:
        # Never break review flow because of troubleshooting logs.
        return
