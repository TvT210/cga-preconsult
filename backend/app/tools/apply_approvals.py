"""把评审台账落到数据库（A-1）。

台账 `docs/structured/scale-approvals.json` 里 `reviewer` 为空的条目，
启动播种时会**跳过**——不写查不到责任人的审批记录。这个脚本就是给那些条目
补上签字人的入口：

```bash
# 先看台账现状
python -m app.tools.apply_approvals --list

# 补签字人并落库（21 张全部）
python -m app.tools.apply_approvals \
    --reviewer 王建民 --title "老年医学科 主任医师" \
    --date 2026-11-18 \
    --comment "2026-11-18 科室例会口头确认，按 WS/T 888—2026 附录 B 执行；签字件待补"

# 只落某几张
python -m app.tools.apply_approvals --reviewer 王建民 --title "…" --date 2026-11-18 \
    --comment "…" --codes B.1 B.2
```

脚本会**同时**更新台账文件与数据库，避免两边打架：台账是版本化的真相，
数据库是运行时真相，只改一边下次重启就回到原样。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from app.core.config import REPO_ROOT
from app.db.base import SessionLocal
from app.db.init_db import init_db
from app.db.models import ScaleTemplate
from app.services import scale_review

LEDGER = REPO_ROOT / "docs" / "structured" / "scale-approvals.json"


def _load() -> dict:
    if not LEDGER.exists():
        raise SystemExit(f"台账不存在：{LEDGER}")
    return json.loads(LEDGER.read_text(encoding="utf-8"))


def _save(data: dict) -> None:
    LEDGER.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def list_entries(data: dict) -> int:
    rows = data.get("approvals") or []
    pending = [row for row in rows if not (row.get("reviewer") or "").strip()]
    print(f"台账共 {len(rows)} 条，其中 {len(pending)} 条待填签字人")
    for row in rows:
        mark = "待填" if row in pending else "已填"
        print(
            f"  [{mark}] {row.get('code', '?'):<5} "
            f"{row.get('scale_name', ''):<24} "
            f"{(row.get('reviewer') or '—')} "
            f"{(row.get('reviewer_title') or '')} "
            f"{row.get('reviewed_at') or ''}"
        )
    return 0 if not pending else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="把量表评审台账落到数据库")
    parser.add_argument("--list", action="store_true", help="只列出台账现状，不修改")
    parser.add_argument("--reviewer", default="", help="签字人姓名")
    parser.add_argument("--title", default="", help="签字人职称或科室")
    parser.add_argument("--date", default="", help="签字日期 YYYY-MM-DD")
    parser.add_argument("--comment", default="", help="依据说明（口头确认必填）")
    parser.add_argument(
        "--evidence",
        default="verbal_confirmation",
        choices=sorted(scale_review.EVIDENCE_TYPES),
        help="凭据类型",
    )
    parser.add_argument("--codes", nargs="*", default=None, help="只处理这些量表编号")
    args = parser.parse_args(argv)

    data = _load()
    if args.list:
        return list_entries(data)

    if not args.reviewer.strip():
        print("缺少 --reviewer：台账必须有签字人，不能为空。", file=sys.stderr)
        return 2

    targets = set(args.codes) if args.codes else None
    rows = data.get("approvals") or []
    changed = 0
    for row in rows:
        if targets is not None and row.get("code") not in targets:
            continue
        row["reviewer"] = args.reviewer.strip()
        row["reviewer_title"] = args.title.strip()
        row["reviewed_at"] = (args.date or dt.date.today().isoformat()).strip()
        row["comment"] = args.comment.strip()
        row["evidence_type"] = args.evidence
        changed += 1
    _save(data)
    print(f"台账已更新 {changed} 条")

    init_db(seed=True)
    db = SessionLocal()
    try:
        applied = 0
        skipped = 0
        for row in rows:
            if targets is not None and row.get("code") not in targets:
                continue
            code = row.get("code")
            scale_row = db.query(ScaleTemplate).filter(ScaleTemplate.code == code).first()
            if scale_row is None:
                continue
            # 已是 approved 的跳过，避免把人工后续决定（deprecated 等）改回去
            if scale_row.review_status != "draft_pending_medical_review":
                skipped += 1
                continue
            try:
                scale_review.apply_review(
                    db,
                    code=code,
                    status="approved",
                    reviewer_name=row.get("reviewer", ""),
                    reviewer_title=row.get("reviewer_title", ""),
                    evidence_type=row.get("evidence_type", ""),
                    comment=row.get("comment", ""),
                    reviewed_at=row.get("reviewed_at", ""),
                    actor=None,
                )
                applied += 1
            except ValueError as exc:
                print(f"  {code} 未落库：{exc}", file=sys.stderr)
        db.commit()
    finally:
        db.close()

    print(f"数据库：新落库 {applied} 张，跳过 {skipped} 张（已有结论）")
    if applied:
        print(
            "提示：凭据不是签字件时，判读结论会保留「签字件待补」提示，"
            "这是有意为之，补到原件后把 --evidence 改为 signed_document 重跑即可。"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
