"""显式新稿的隔离、计划冲突与提交重试；旧矩阵保留在 test_migration。"""

from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.db import get_conn
from app.services import document_migration
from tests.test_migration import add_region, bind, make_block
from tests.test_migration import scene as scene


def prepare(s: dict) -> tuple[int, int, int]:
    source = add_region(s["src"]["id"], "填写内容", "name", 0)
    target = add_region(s["dst"]["id"], "新位置", "name", 0)
    block = make_block(s["client"], "可复用正文")
    bind(s["client"], s["src_vid"], source, block)
    return source, target, block


def plan(s: dict) -> dict:
    response = s["client"].post(
        f"/api/templates/{s['dst']['id']}/migrate/plan",
        json={
            "source_version_id": s["src_vid"],
            "mode": "new_document",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def payload(s: dict, source: int, target: int) -> dict:
    return {
        "source_version_id": s["src_vid"],
        "mode": "new_document",
        "name": "新版文稿",
        "plan_token": plan(s)["plan_token"],
        "idempotency_key": uuid4().hex,
        "placements": [{"source_region_id": source, "target_region_id": target}],
    }


def count(s: dict) -> int:
    return len(s["client"].get(f"/api/templates/{s['dst']['id']}/versions").json()["versions"])


def apply(s: dict, body: dict) -> httpx.Response:
    return s["client"].post(f"/api/templates/{s['dst']['id']}/migrate/apply", json=body)


@pytest.mark.parametrize("empty", [False, True])
def test_new_document_preserves_source_and_target(scene: dict, empty: bool) -> None:
    s, t, b = prepare(scene)
    client = scene["client"]
    if empty:
        client.delete(f"/api/versions/{scene['dst_vid']}?allow_empty_template=true")
    else:
        bind(client, scene["dst_vid"], t, b)
    before = count(scene)
    p = plan(scene)
    assert p["target_version_id"] is None
    assert p["source_items"][0]["content"] == "内容"
    assert count(scene) == before
    response = apply(scene, payload(scene, s, t))
    assert response.status_code == 201
    assert count(scene) == before + 1
    assert response.json()["version_id"] != scene["src_vid"]
    with get_conn() as conn:
        assert (
            conn.execute(
                "SELECT block_id FROM bindings WHERE version_id = ?", (scene["src_vid"],)
            ).fetchone()[0]
            == b
        )
        if not empty:
            assert (
                conn.execute(
                    "SELECT block_id FROM bindings WHERE version_id = ?", (scene["dst_vid"],)
                ).fetchone()[0]
                == b
            )


def test_explicit_omission_required(scene: dict) -> None:
    s, t, _ = prepare(scene)
    body = payload(scene, s, t)
    body["placements"] = []
    assert apply(scene, body).json()["error"]["code"] == "MIGRATION_INVALID"
    assert count(scene) == 1
    body["omitted_source_region_ids"] = [s]
    assert apply(scene, body).json()["created"] == 0
    assert count(scene) == 2


def test_removed_paragraph_filters_siblings_by_path_not_anchor_json(scene: dict) -> None:
    s, _, b = prepare(scene)
    sibling = add_region(scene["src"]["id"], "同段字段", "work", 1)
    bind(scene["client"], scene["src_vid"], sibling, b)
    with get_conn() as conn:
        conn.execute(
            "UPDATE regions SET anchor = ? WHERE id = ?",
            ('{"path":[0],"kind":"p","extra":"metadata"}', sibling),
        )
        conn.execute(
            "INSERT INTO version_region_actions VALUES (?, ?, 'remove')", (scene["src_vid"], s)
        )
    assert plan(scene)["source_items"] == []


@pytest.mark.parametrize("change", ["content", "target", "layout"])
def test_stale_plan_does_not_create(scene: dict, change: str) -> None:
    s, t, b = prepare(scene)
    body = payload(scene, s, t)
    with get_conn() as conn:
        if change == "content":
            conn.execute("UPDATE blocks SET content = '已变化' WHERE id = ?", (b,))
        elif change == "target":
            conn.execute("UPDATE regions SET review_status = 'excluded' WHERE id = ?", (t,))
        else:
            conn.execute(
                "INSERT INTO version_region_actions VALUES (?, ?, 'remove')", (scene["src_vid"], s)
            )
    assert apply(scene, body).json()["error"]["code"] == "MIGRATION_PLAN_STALE"
    assert count(scene) == 1


def test_receipt_survives_restart_and_deleted_result(scene: dict) -> None:
    s, t, _ = prepare(scene)
    body = payload(scene, s, t)
    first = apply(scene, body).json()
    assert scene["client"].post("/api/history/undo").status_code == 200
    assert apply(scene, body).status_code == 410
    assert count(scene) == 1
    assert scene["client"].post("/api/history/redo").status_code == 200
    assert apply(scene, body).json() == first
    with TestClient(create_app()) as restarted:
        scene["client"] = restarted
        assert apply(scene, body).json() == first
        assert (
            apply(scene, {**body, "name": "另一名称"}).json()["error"]["code"]
            == "MIGRATION_REQUEST_CONFLICT"
        )
        restarted.delete(f"/api/versions/{first['version_id']}?allow_empty_template=true")
        assert apply(scene, body).status_code == 410
        assert count(scene) == 1


def test_concurrent_retry_creates_once(scene: dict) -> None:
    s, t, _ = prepare(scene)
    body = payload(scene, s, t)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: apply(scene, body).json(), range(2)))
    assert results[0] == results[1]
    assert count(scene) == 2


def test_binding_failure_rolls_back(scene: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    s, t, _ = prepare(scene)
    body = payload(scene, s, t)

    def fail(*args: object, **kwargs: object) -> None:
        raise RuntimeError("write failed")

    monkeypatch.setattr(document_migration.bindings, "upsert_binding", fail)
    with pytest.raises(RuntimeError, match="write failed"):
        apply(scene, body)
    assert count(scene) == 1
    with get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM migration_receipts").fetchone()[0] == 0


@pytest.mark.parametrize(
    "case", ["duplicate_source", "duplicate_target", "both", "foreign", "unknown_source", "no_key"]
)
def test_invalid_decisions_never_create(scene: dict, case: str) -> None:
    s, t, _ = prepare(scene)
    body = payload(scene, s, t)
    if case == "duplicate_source":
        other = add_region(scene["dst"]["id"], "第二位置", "work", 1)
        body["plan_token"] = plan(scene)["plan_token"]
        body["placements"].append({"source_region_id": s, "target_region_id": other})
    elif case == "duplicate_target":
        body["placements"] *= 2
    elif case == "both":
        body["omitted_source_region_ids"] = [s]
    elif case == "foreign":
        body["placements"][0]["target_region_id"] = s
    elif case == "unknown_source":
        body["placements"][0]["source_region_id"] = 9999
    else:
        body["idempotency_key"] = ""
    response = apply(scene, body)
    assert response.status_code == 400, response.text
    assert count(scene) == 1


def test_source_visible_content_and_settings_survive_review_flags(scene: dict) -> None:
    s, t, _ = prepare(scene)
    with get_conn() as conn:
        conn.execute("UPDATE regions SET review_status = 'excluded' WHERE id = ?", (s,))
        conn.execute(
            "UPDATE bindings SET line_break_mode = 'soft', position = 'after' WHERE version_id = ?",
            (scene["src_vid"],),
        )
    response = apply(scene, payload(scene, s, t))
    assert response.status_code == 201
    with get_conn() as conn:
        row = conn.execute(
            "SELECT line_break_mode, position FROM bindings WHERE version_id = ?",
            (response.json()["version_id"],),
        ).fetchone()
        assert tuple(row) == ("soft", "after")


def test_name_collision_rolls_back_and_key_can_retry(scene: dict) -> None:
    s, t, _ = prepare(scene)
    body = payload(scene, s, t)
    scene["client"].post(
        f"/api/templates/{scene['dst']['id']}/versions", json={"name": body["name"]}
    )
    assert apply(scene, body).json()["error"]["code"] == "VERSION_NAME_TAKEN"
    body["name"] = "另一份新稿"
    assert apply(scene, body).status_code == 201
    assert count(scene) == 3


@pytest.mark.parametrize("manual", [False, True])
def test_derived_geometry_does_not_stale_plan_but_manual_frame_does(
    scene: dict, manual: bool
) -> None:
    s, t, _ = prepare(scene)
    body = payload(scene, s, t)
    with get_conn() as conn:
        conn.execute(
            "UPDATE regions SET bbox_json = ?, bbox_source = ? WHERE id = ?",
            ('{"page":0,"x0":10,"y0":10,"x1":40,"y1":30}', "manual" if manual else "auto", t),
        )
    response = apply(scene, body)
    assert response.status_code == (409 if manual else 201)
