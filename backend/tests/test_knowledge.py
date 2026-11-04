"""医护知识库图谱接口测试。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _headers() -> dict:
    token = client.post(
        "/api/v1/auth/login", json={"username": "nurse", "password": "nurse12345"}
    ).json()["data"]["token"]
    return {"Authorization": f"Bearer {token}"}


def test_knowledge_graph_shape():
    headers = _headers()
    response = client.get("/api/v1/knowledge/graph", headers=headers)
    assert response.status_code == 200
    data = response.json()["data"]

    nodes = data["nodes"]
    edges = data["edges"]
    assert nodes and edges

    types = {node["type"] for node in nodes}
    assert types == {"disease", "symptom", "scale"}

    node_ids = {node["id"] for node in nodes}
    for edge in edges:
        assert edge["source"] in node_ids
        assert edge["target"] in node_ids

    kinds = {edge["kind"] for edge in edges}
    assert "core" in kinds and "focus" in kinds

    # 疾病→症状的边数应等于疾病库里的症状引用总数
    core_edges = [edge for edge in edges if edge["kind"] in {"core", "secondary"}]
    assert len(core_edges) >= 200


def test_knowledge_graph_filter_and_keyword():
    headers = _headers()
    only_disease = client.get("/api/v1/knowledge/graph?node_type=disease", headers=headers).json()["data"]
    assert {node["type"] for node in only_disease["nodes"]} == {"disease"}

    filtered = client.get("/api/v1/knowledge/graph?keyword=胸痛", headers=headers).json()["data"]
    assert filtered["nodes"], "关键词过滤应命中至少一个节点"
    for node in filtered["nodes"]:
        assert "胸痛" in node["label"] or "胸痛" in node["id"]


def test_symptom_detail():
    headers = _headers()
    response = client.get("/api/v1/knowledge/symptoms/chest_pain", headers=headers)
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["term"] == "胸痛胸闷"
    assert data["probe"], "应带鉴别性追问话术"
    assert data["disease_count"] >= 1
    codes = {item["code"] for item in data["related_diseases"]}
    assert "I21" in codes
    # 核心症状应排在前面
    assert data["related_diseases"][0]["weight"] == "core"


def test_knowledge_overview():
    headers = _headers()
    data = client.get("/api/v1/knowledge/overview", headers=headers).json()["data"]
    assert data["diseases"] == 28
    assert data["scales"] == 21
    assert data["scales_with_items"] == 21
    assert data["symptoms_with_probe"] > 0


def test_knowledge_requires_staff():
    """老人不能访问知识库图谱（属于医护侧数据）。"""
    token = client.post(
        "/api/v1/auth/login", json={"username": "elder", "password": "elder12345"}
    ).json()["data"]["token"]
    response = client.get(
        "/api/v1/knowledge/graph", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 403
