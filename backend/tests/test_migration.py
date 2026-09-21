"""迁移域测试（M10）：plan 匹配矩阵 + apply 校验守门（PRD 4.7 / D7）。

测试用纯文本 docx（无占位符 → 模板 regions 为空），区域全部经 repo 直插，
精确控制类型 / 文档流顺序 / 校对状态。
"""

from collections.abc import Iterator
from io import BytesIO
from uuid import uuid4

import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.models.db import get_conn
from app.models.repositories import regions as regions_repo


def make_plain_docx(text: str = "普通正文段落，无占位符") -> bytes:
    doc = Document()
    doc.add_paragraph(text)
    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


def upload_template(client: TestClient, name: str) -> dict:
    # 内容唯一化：同 sha256 会被 D10 指纹关联回已有模板（409→200 reused）
    marker = f"{name}-{id(name) % 100000}-{uuid4().hex[:8]}"
    resp = client.post(
        "/api/templates",
        files={"file": (name, make_plain_docx(marker), "application/octet-stream")},
    )
    assert resp.status_code == 201
    return resp.json()


def add_region(
    template_id: int, label: str, rtype: str, order: int, review: str = "confirmed"
) -> int:
    """直插区域（测试专用）：anchor 用最小占位（迁移匹配只看类型 + order_index）。"""
    with get_conn() as conn:
        region = regions_repo.create_region(
            conn,
            template_id,
            region_type=rtype,
            label=label,
            anchor={"kind": "p", "path": [order]},
            order_index=order,
            review_status=review,
        )
    return region.id


def make_block(client: TestClient, name: str) -> int:
    resp = client.post("/api/blocks", json={"name": name, "content": "内容"})
    assert resp.status_code == 201
    return resp.json()["id"]


def bind(client: TestClient, version_id: int, region_id: int, block_id: int) -> None:
    resp = client.post(
        f"/api/versions/{version_id}/bindings",
        json={"region_id": region_id, "block_id": block_id},
    )
    assert resp.status_code == 200


def plan(client: TestClient, target_tid: int, source_vid: int):
    return client.post(
        f"/api/templates/{target_tid}/migrate/plan",
        json={"source_version_id": source_vid},
    )


def apply(client: TestClient, target_tid: int, source_vid: int, bindings: list[dict]):
    return client.post(
        f"/api/templates/{target_tid}/migrate/apply",
        json={"source_version_id": source_vid, "bindings": bindings},
    )


@pytest.fixture
def scene(client: TestClient) -> Iterator[dict]:
    """源模板（含默认版本与待迁移绑定）+ 目标模板（空白默认版本）。"""
    src = upload_template(client, "旧模板.docx")
    dst = upload_template(client, "新模板.docx")
    yield {
        "client": client,
        "src": src,
        "dst": dst,
        "src_vid": src["default_version_id"],
        "dst_vid": dst["default_version_id"],
    }


# ---- plan：前置守门 ----


def test_plan_same_template_400(scene: dict) -> None:
    resp = plan(scene["client"], scene["src"]["id"], scene["src_vid"])
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "MIGRATION_SAME_TEMPLATE"


def test_plan_source_version_not_found_404(scene: dict) -> None:
    resp = plan(scene["client"], scene["dst"]["id"], 9999)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "VERSION_NOT_FOUND"


def test_plan_target_template_not_found_404(scene: dict) -> None:
    resp = plan(scene["client"], 9999, scene["src_vid"])
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "TEMPLATE_NOT_FOUND"


def test_plan_target_not_blank_409(scene: dict) -> None:
    c = scene["client"]
    rid = add_region(scene["dst"]["id"], "姓名", "name", 0)
    bind(c, scene["dst_vid"], rid, make_block(c, "已有块"))
    resp = plan(c, scene["dst"]["id"], scene["src_vid"])
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "MIGRATION_TARGET_NOT_BLANK"


# ---- plan：匹配矩阵（D7 同类型按文档流顺序）----


def test_plan_auto_equal_counts_by_flow_order(scene: dict) -> None:
    c = scene["client"]
    s1 = add_region(scene["src"]["id"], "姓名", "name", 0)
    s2 = add_region(scene["src"]["id"], "工作经历", "work", 1)
    b1, b2 = make_block(c, "块一"), make_block(c, "块二")
    bind(c, scene["src_vid"], s1, b1)
    bind(c, scene["src_vid"], s2, b2)
    t1 = add_region(scene["dst"]["id"], "名字", "name", 0)
    t2 = add_region(scene["dst"]["id"], "工作", "work", 5)

    resp = plan(c, scene["dst"]["id"], scene["src_vid"])
    assert resp.status_code == 200
    body = resp.json()
    assert body["target_version_id"] == scene["dst_vid"]
    assert body["candidates"] == []
    assert body["unmatched"] == []
    assert body["auto"] == [
        {
            "source_region_id": s1,
            "source_label": "姓名",
            "target_region_id": t1,
            "target_label": "名字",
            "block_id": b1,
            "block_name": "块一",
        },
        {
            "source_region_id": s2,
            "source_label": "工作经历",
            "target_region_id": t2,
            "target_label": "工作",
            "block_id": b2,
            "block_name": "块二",
        },
    ]


def test_plan_types_align_within_type_not_globally(scene: dict) -> None:
    """同类型内按序对齐：源流序 work,name,work,name ↔ 目标 name,work,work,name。"""
    c = scene["client"]
    w1 = add_region(scene["src"]["id"], "工作一", "work", 0)
    n1 = add_region(scene["src"]["id"], "姓名一", "name", 1)
    w2 = add_region(scene["src"]["id"], "工作二", "work", 2)
    n2 = add_region(scene["src"]["id"], "姓名二", "name", 3)
    for rid, blk in [(w1, "块甲"), (n1, "块乙"), (w2, "块丙"), (n2, "块丁")]:
        bind(c, scene["src_vid"], rid, make_block(c, blk))
    tn1 = add_region(scene["dst"]["id"], "目标名一", "name", 0)
    tw1 = add_region(scene["dst"]["id"], "目标工一", "work", 1)
    tw2 = add_region(scene["dst"]["id"], "目标工二", "work", 2)
    tn2 = add_region(scene["dst"]["id"], "目标名二", "name", 3)

    body = plan(c, scene["dst"]["id"], scene["src_vid"]).json()
    assert body["candidates"] == [] and body["unmatched"] == []
    pairs = {(a["source_region_id"], a["target_region_id"]) for a in body["auto"]}
    assert pairs == {(w1, tw1), (w2, tw2), (n1, tn1), (n2, tn2)}


def test_plan_surplus_source_bindings_to_unmatched(scene: dict) -> None:
    """源 3 > 目标 2：前 2 个自动匹配，多出的进③不自动丢弃（D7/PRD 边界）。"""
    c = scene["client"]
    srcs = [add_region(scene["src"]["id"], f"工作{i}", "work", i) for i in range(3)]
    for i, rid in enumerate(srcs):
        bind(c, scene["src_vid"], rid, make_block(c, f"块{i}"))
    t1 = add_region(scene["dst"]["id"], "目标工一", "work", 0)
    t2 = add_region(scene["dst"]["id"], "目标工二", "work", 1)

    body = plan(c, scene["dst"]["id"], scene["src_vid"]).json()
    assert [(a["source_region_id"], a["target_region_id"]) for a in body["auto"]] == [
        (srcs[0], t1),
        (srcs[1], t2),
    ]
    assert len(body["candidates"]) == 0
    assert [u["source_region_id"] for u in body["unmatched"]] == [srcs[2]]
    # ③ 手动指定候选 = 全部未被自动占用的目标区域（任意类型）
    assert [o["region_id"] for o in body["unmatched"][0]["manual_options"]] == []


def test_plan_more_targets_to_candidates(scene: dict) -> None:
    """目标同类型区域多于源 → ②多候选（不自动猜）；候选为同类型全部未占用区域。"""
    c = scene["client"]
    s1 = add_region(scene["src"]["id"], "工作", "work", 0)
    bind(c, scene["src_vid"], s1, make_block(c, "块名"))
    t1 = add_region(scene["dst"]["id"], "目标工一", "work", 0)
    t2 = add_region(scene["dst"]["id"], "目标工二", "work", 1)
    t3 = add_region(scene["dst"]["id"], "目标工三", "work", 2)

    body = plan(c, scene["dst"]["id"], scene["src_vid"]).json()
    assert body["auto"] == []
    assert len(body["candidates"]) == 1
    row = body["candidates"][0]
    assert row["source_region_id"] == s1
    assert [o["region_id"] for o in row["options"]] == [t1, t2, t3]


def test_plan_type_absent_to_unmatched_with_free_options(scene: dict) -> None:
    """目标无同类型区域 → ③；手动候选 = 未占用的任意类型区域。"""
    c = scene["client"]
    s1 = add_region(scene["src"]["id"], "项目经历", "project", 0)
    bind(c, scene["src_vid"], s1, make_block(c, "块名"))
    t_free1 = add_region(scene["dst"]["id"], "目标自一", "custom", 0)
    t_free2 = add_region(scene["dst"]["id"], "目标自二", "custom", 1)

    body = plan(c, scene["dst"]["id"], scene["src_vid"]).json()
    assert body["auto"] == [] and body["candidates"] == []
    assert len(body["unmatched"]) == 1
    options = [o["region_id"] for o in body["unmatched"][0]["manual_options"]]
    assert options == [t_free1, t_free2]


def test_plan_custom_never_auto(scene: dict) -> None:
    """custom 不参与自动匹配：有同类型目标 → ②（每个源绑定一行，客户端互斥去重）；无 → ③。"""
    c = scene["client"]
    s1 = add_region(scene["src"]["id"], "自定义一", "custom", 0)
    s2 = add_region(scene["src"]["id"], "自定义二", "custom", 1)
    bind(c, scene["src_vid"], s1, make_block(c, "块一"))
    bind(c, scene["src_vid"], s2, make_block(c, "块二"))
    t1 = add_region(scene["dst"]["id"], "目标自一", "custom", 0)

    body = plan(c, scene["dst"]["id"], scene["src_vid"]).json()
    assert body["auto"] == []
    # 两个 custom 源绑定各出一行②候选，选项同为 t1；占用冲突由前端互斥选择解决
    assert [row["source_region_id"] for row in body["candidates"]] == [s1, s2]
    for row in body["candidates"]:
        assert [o["region_id"] for o in row["options"]] == [t1]
    assert body["unmatched"] == []


def test_plan_custom_without_target_to_unmatched(scene: dict) -> None:
    """custom 源绑定但目标无 custom 区域 → ③（手动指定任意区域或留空）。"""
    c = scene["client"]
    s1 = add_region(scene["src"]["id"], "自定义", "custom", 0)
    bind(c, scene["src_vid"], s1, make_block(c, "块名"))
    t_free = add_region(scene["dst"]["id"], "目标工作", "work", 0)

    body = plan(c, scene["dst"]["id"], scene["src_vid"]).json()
    assert body["auto"] == [] and body["candidates"] == []
    assert [u["source_region_id"] for u in body["unmatched"]] == [s1]
    assert [o["region_id"] for o in body["unmatched"][0]["manual_options"]] == [t_free]


def test_plan_excluded_target_not_candidate(scene: dict) -> None:
    """已排除目标区域：不参与自动匹配也不进候选（与 REGION_EXCLUDED 同口径）。"""
    c = scene["client"]
    s1 = add_region(scene["src"]["id"], "工作", "work", 0)
    bind(c, scene["src_vid"], s1, make_block(c, "块名"))
    add_region(scene["dst"]["id"], "目标工一", "work", 0, review="excluded")
    t2 = add_region(scene["dst"]["id"], "目标工二", "work", 1)

    body = plan(c, scene["dst"]["id"], scene["src_vid"]).json()
    assert [(a["source_region_id"], a["target_region_id"]) for a in body["auto"]] == [(s1, t2)]


def test_plan_missing_bindings_skipped(scene: dict) -> None:
    """missing 态绑定不迁移（异常态不扩散，与 M8 复制底稿同口径）。"""
    c = scene["client"]
    s1 = add_region(scene["src"]["id"], "姓名", "name", 0)
    bid = make_block(c, "将删块")
    bind(c, scene["src_vid"], s1, bid)
    # 块软删除 → 绑定置 missing
    assert c.delete(f"/api/blocks/{bid}").status_code == 204
    resp = plan(c, scene["dst"]["id"], scene["src_vid"])
    assert resp.status_code == 200
    assert resp.json()["auto"] == []
    assert resp.json()["candidates"] == []
    assert resp.json()["unmatched"] == []


# ---- apply：落库与守门 ----


def test_apply_creates_bindings_and_renders(scene: dict) -> None:
    c = scene["client"]
    s1 = add_region(scene["src"]["id"], "姓名", "name", 0)
    b1 = make_block(c, "块一")
    bind(c, scene["src_vid"], s1, b1)
    t1 = add_region(scene["dst"]["id"], "目标名", "name", 0)

    plan_body = plan(c, scene["dst"]["id"], scene["src_vid"]).json()
    bindings = [
        {"region_id": a["target_region_id"], "block_id": a["block_id"]} for a in plan_body["auto"]
    ]
    resp = apply(c, scene["dst"]["id"], scene["src_vid"], bindings)
    assert resp.status_code == 201
    assert resp.json() == {"version_id": scene["dst_vid"], "created": 1}

    items = c.get(f"/api/versions/{scene['dst_vid']}/bindings").json()["bindings"]
    assert [(i["region_id"], i["block_id"], i["status"]) for i in items] == [(t1, b1, "active")]


def test_apply_all_blank_ok(scene: dict) -> None:
    """②③全部留空：apply 空清单合法（created=0）。"""
    s1 = add_region(scene["src"]["id"], "姓名", "name", 0)
    bind(scene["client"], scene["src_vid"], s1, make_block(scene["client"], "块名"))
    resp = apply(scene["client"], scene["dst"]["id"], scene["src_vid"], [])
    assert resp.status_code == 201
    assert resp.json()["created"] == 0


def test_apply_target_not_blank_409(scene: dict) -> None:
    """plan 与 apply 之间目标版本被写入绑定 → 409 拒绝（不混入不覆盖）。"""
    c = scene["client"]
    s1 = add_region(scene["src"]["id"], "姓名", "name", 0)
    bind(c, scene["src_vid"], s1, make_block(c, "块名"))
    t1 = add_region(scene["dst"]["id"], "目标名", "name", 0)
    # apply 前目标版本被人手动绑了一个区域
    bind(c, scene["dst_vid"], t1, make_block(c, "抢先块"))

    resp = apply(c, scene["dst"]["id"], scene["src_vid"], [{"region_id": t1, "block_id": 1}])
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "MIGRATION_TARGET_NOT_BLANK"


def test_apply_validations(scene: dict) -> None:
    c = scene["client"]
    s1 = add_region(scene["src"]["id"], "姓名", "name", 0)
    bind(c, scene["src_vid"], s1, make_block(c, "块名"))
    t1 = add_region(scene["dst"]["id"], "目标名", "name", 0)

    # 区域不存在
    resp = apply(c, scene["dst"]["id"], scene["src_vid"], [{"region_id": 9999, "block_id": 1}])
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "REGION_NOT_FOUND"
    # 块不存在 / 已软删（区域用目标模板的）
    bid = make_block(c, "待删块")
    c.delete(f"/api/blocks/{bid}")
    resp = apply(c, scene["dst"]["id"], scene["src_vid"], [{"region_id": t1, "block_id": bid}])
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "BLOCK_NOT_FOUND"
    # 区域不属于目标模板（拿源模板区域提交）
    resp = apply(c, scene["dst"]["id"], scene["src_vid"], [{"region_id": s1, "block_id": 1}])
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "REGION_TEMPLATE_MISMATCH"
    # 提交清单内区域重复
    t1 = add_region(scene["dst"]["id"], "目标名", "name", 0)
    dup = [{"region_id": t1, "block_id": 1}, {"region_id": t1, "block_id": 1}]
    resp = apply(c, scene["dst"]["id"], scene["src_vid"], dup)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "REGION_TEMPLATE_MISMATCH"
    # 已排除区域拒绑
    tex = add_region(scene["dst"]["id"], "排除区", "custom", 1, review="excluded")
    resp = apply(c, scene["dst"]["id"], scene["src_vid"], [{"region_id": tex, "block_id": 1}])
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "REGION_EXCLUDED"


def test_apply_rejected_leaves_no_partial_writes(scene: dict) -> None:
    """校验失败整事务回滚：出错前的合法对也不落库。"""
    c = scene["client"]
    s1 = add_region(scene["src"]["id"], "姓名", "name", 0)
    b1 = make_block(c, "块一")
    bind(c, scene["src_vid"], s1, b1)
    t1 = add_region(scene["dst"]["id"], "目标名", "name", 0)

    bad = [
        {"region_id": t1, "block_id": b1},  # 合法
        {"region_id": 9999, "block_id": b1},  # 非法 → 整体回滚
    ]
    resp = apply(c, scene["dst"]["id"], scene["src_vid"], bad)
    assert resp.status_code == 404
    items = c.get(f"/api/versions/{scene['dst_vid']}/bindings").json()["bindings"]
    assert items == []
