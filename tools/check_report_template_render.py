"""报告模板渲染校验：生成专业版/通俗版报告并导出 PDF/Word 渲染成图片。"""

from __future__ import annotations

import pathlib
import sys

import httpx

BASE = "http://127.0.0.1:8000/api/v1"
OUT = pathlib.Path(r"D:\ALLCODE\work\word2\output\report-templates")
OUT.mkdir(parents=True, exist_ok=True)


def main() -> int:
    with httpx.Client(timeout=30) as client:
        def call(method: str, path: str, **kwargs):
            response = client.request(method, f"{BASE}{path}", **kwargs)
            body = response.json()
            if body.get("code") != 0:
                raise SystemExit(f"{method} {path} 失败：{body}")
            return body["data"]

        doctor = call("POST", "/auth/login", json={"username": "doctor", "password": "doctor12345"})
        headers = {"Authorization": f"Bearer {doctor['token']}"}

        templates = call("GET", "/report-templates", headers=headers)
        print(f"[1] 报告模板：{[t['code'] for t in templates]}")

        patients = call("GET", "/patients", headers=headers)
        patient_id = patients["items"][0]["id"]

        for code in ("professional", "plain"):
            report = call(
                "POST",
                "/reports",
                headers=headers,
                json={"patient_id": patient_id, "template_code": code},
            )
            pdf = call  # placeholder to keep linters quiet
            response = client.get(
                f"{BASE}/reports/{report['id']}/export?format=pdf", headers=headers
            )
            (OUT / f"{code}.pdf").write_bytes(response.content)
            response = client.get(
                f"{BASE}/reports/{report['id']}/export?format=docx", headers=headers
            )
            (OUT / f"{code}.docx").write_bytes(response.content)
            print(f"[2] {code}：报告 v{report['version']}，PDF {len((OUT / f'{code}.pdf').read_bytes())} 字节，"
                  f"Word {len((OUT / f'{code}.docx').read_bytes())} 字节")

    try:
        import pymupdf
    except ImportError:
        print("pymupdf 未安装，跳过渲染")
        return 0
    for name in ("professional", "plain"):
        document = pymupdf.open(OUT / f"{name}.pdf")
        for index, page in enumerate(document, start=1):
            page.get_pixmap(dpi=100).save(OUT / f"{name}_p{index}.png")
        print(f"[3] {name}.pdf 共 {len(document)} 页，已渲染 PNG")
    return 0


if __name__ == "__main__":
    sys.exit(main())
