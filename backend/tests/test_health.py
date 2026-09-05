"""/api/health 测试：服务存活 + LibreOffice 状态字段结构。"""

from fastapi.testclient import TestClient

from app.main import app


def make_client() -> TestClient:
    return TestClient(app)


def test_health_ok() -> None:
    resp = make_client().get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


def test_health_libreoffice_fields() -> None:
    """LibreOffice 装没装都合法，但字段结构必须稳定（前端依赖）。"""
    body = make_client().get("/api/health").json()
    lo = body["libreoffice"]
    assert isinstance(lo["available"], bool)
    if lo["available"]:
        assert lo["path"]
        assert lo["version"]
        assert lo["hint"] is None
    else:
        assert lo["hint"]  # 缺依赖必须给安装指引（D2）
