"""导出报告 PDF/Word 并渲染为 PNG，用于人工校验排版与中文字形。"""

from __future__ import annotations

import pathlib
import sys

import httpx

BASE = "http://127.0.0.1:8000/api/v1"
OUT = pathlib.Path(r"D:\ALLCODE\work\word2\output\report-check")
OUT.mkdir(parents=True, exist_ok=True)


def main() -> int:
    with httpx.Client(timeout=30) as client:
        token = client.post(
            f"{BASE}/auth/login", json={"username": "doctor", "password": "doctor12345"}
        ).json()["data"]["token"]
        headers = {"Authorization": f"Bearer {token}"}
        patients = client.get(f"{BASE}/patients", headers=headers).json()["data"]["items"]
        if not patients:
            print("没有患者数据，先跑 demo_e2e.py")
            return 1
        patient_id = patients[0]["id"]
        report = client.post(f"{BASE}/reports", headers=headers, json={"patient_id": patient_id}).json()["data"]
        pdf = client.get(f"{BASE}/reports/{report['id']}/export?format=pdf", headers=headers).content
        docx = client.get(f"{BASE}/reports/{report['id']}/export?format=docx", headers=headers).content
        (OUT / "report.pdf").write_bytes(pdf)
        (OUT / "report.docx").write_bytes(docx)
        print("pdf:", len(pdf), "docx:", len(docx), "->", OUT)

    try:
        import pymupdf
    except ImportError:
        print("pymupdf 未安装，跳过渲染")
        return 0
    document = pymupdf.open(OUT / "report.pdf")
    for index, page in enumerate(document, start=1):
        pixmap = page.get_pixmap(dpi=110)
        pixmap.save(OUT / f"report_p{index}.png")
    print("rendered pages:", len(document))
    return 0


if __name__ == "__main__":
    sys.exit(main())
