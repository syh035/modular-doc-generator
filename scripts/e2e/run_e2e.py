"""三大场景 E2E runner（/usr/bin/python3 运行——本机 Playwright 装在系统 Python）。

用法（仓库根目录，后端/前端服务未起会自动拉起并在退出时清理）：
    /usr/bin/python3 scripts/e2e/run_e2e.py [1|2|3|all]    # 默认 all

分工（沿既有验收惯例）：fixture 播种与产物校验走 backend/.venv（docx/httpx/PyMuPDF），
浏览器流走本脚本（Playwright chromium headless 1440x900，accept_downloads）。

场景（AGENTS.md 完成判据：日常沉淀 / 定向投递 / 模板换装）：
  1 日常沉淀：选模板 → 校对确认占位符区域 → 建字符块 → 正向绑定 ×2 →
              图例「已绑定 2」+ 预览 PDF 文本校验（替换生效、无 {{ 残留）
  2 定向投递：校对确认 → 建长内容块绑定 → 固定行高裁剪 → 大超出红框+状态条 →
              新建版本（复制底稿）→ 版本来回切换 → 导出触发警示弹层 →
              确认导出 → 文件名「简历-{版本名}-{日期}.docx」+ 产物内容校验
  3 模板换装：目标模板校对至 ready → 源模板建块绑定 ×2 → 切目标模板触发迁移
              弹层 → 三清单确认（自动匹配 2）→ 绑定零重录 → 预览校验

每场景独立播种（模板内嵌时间戳，恒为全新模板）；console error 仅收集汇报不判失败
（已知 cosmetic：解绑 204 经 Vite 代理的 ERR_ABORTED，见 TODO.md 观察项）。
"""

from __future__ import annotations

import atexit
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV_PY = BACKEND / ".venv" / "bin" / "python"
SEED = Path(__file__).resolve().parent / "seed.py"
VERIFY = Path(__file__).resolve().parent / "verify.py"
DOWNLOAD_DIR = Path("/tmp/e2e_downloads")

FRONTEND_URL = "http://localhost:5173"  # vite 默认监听 [::1]，用 localhost 双栈解析
CANVAS_TIMEOUT = 180_000  # LO 冷转换余量（P17 fontconfig 冷缓存可达数分钟）
RENDER_TIMEOUT = 120_000  # 绑定/迁移后的局部刷新（替换产物首次 LO 转换）
DEFAULT_TIMEOUT = 15_000

_spawned: list[subprocess.Popen] = []


# ---- 环境准备 ----

def _port_up(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=3):
            return True
    except Exception:
        return False


def _frontend_up() -> bool:
    """vite 可能只绑 [::1]（IPv6）或双栈，两个栈都探。"""
    return _port_up("http://localhost:5173") or _port_up("http://[::1]:5173")


def ensure_services() -> None:
    """服务已在则复用；缺哪个补哪个（补的部分退出时清理）。"""
    if not _port_up("http://127.0.0.1:8740/api/health"):
        print("· 启动后端 http://127.0.0.1:8740 …")
        proc = subprocess.Popen(
            [str(VENV_PY), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8740"],
            cwd=BACKEND,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _spawned.append(proc)
        deadline = time.time() + 60
        while time.time() < deadline:
            if _port_up("http://127.0.0.1:8740/api/health"):
                break
            if proc.poll() is not None:
                raise SystemExit("后端进程提前退出，请检查 8740 端口与 backend 日志")
            time.sleep(0.5)
        else:
            raise SystemExit("后端 60s 未就绪")
    else:
        print("· 后端已在运行，直接复用")

    if not _frontend_up():
        npm = shutil.which("npm")
        if npm is None:
            raise SystemExit("未找到 npm，无法启动前端；请先 ./scripts/dev.sh")
        print("· 启动前端 http://127.0.0.1:5173 …")
        proc = subprocess.Popen(
            [npm, "run", "dev"],
            cwd=FRONTEND,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _spawned.append(proc)
        deadline = time.time() + 60
        while time.time() < deadline:
            if _frontend_up():
                break
            if proc.poll() is not None:
                raise SystemExit("前端进程提前退出，请检查 5173 端口与 frontend 日志")
            time.sleep(0.5)
        else:
            raise SystemExit("前端 60s 未就绪")
    else:
        print("· 前端已在运行，直接复用")


def cleanup() -> None:
    for proc in _spawned:
        if proc.poll() is None:
            proc.terminate()
    for proc in _spawned:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# ---- venv 侧播种 / 校验 ----

def _run_venv(script: Path, *args: str) -> str:
    result = subprocess.run(
        [str(VENV_PY), str(script), *args], capture_output=True, text=True, timeout=300
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"venv 脚本失败（{script.name} {' '.join(args)}）:\n{result.stdout}\n{result.stderr}"
        )
    return result.stdout


def seed(scenario: int) -> list[dict]:
    out = _run_venv(SEED, str(scenario))
    return json.loads(out.strip().splitlines()[-1])["templates"]


def verify_preview(template_id: int, expect: list[str], absent: list[str]) -> dict:
    args = ["preview", "--template-id", str(template_id)]
    args += _text_args(expect, absent)
    return json.loads(_run_venv(VERIFY, *args).strip().splitlines()[-1])


def verify_export_file(path: Path, expect: list[str], absent: list[str]) -> dict:
    args = ["export-file", "--path", str(path)]
    args += _text_args(expect, absent)
    return json.loads(_run_venv(VERIFY, *args).strip().splitlines()[-1])


def _text_args(expect: list[str], absent: list[str]) -> list[str]:
    args: list[str] = []
    for text in expect:
        args += ["--expect", text]
    for text in absent:
        args += ["--absent", text]
    return args


# ---- 浏览器通用操作 ----

# 诊断事件（console 全量 / 整页导航 / 渲染进程崩溃），单场景一清，FAIL 时输出尾部。
# 背景：整页 reload 不来自应用代码（前端无 location/reload），嫌疑在 Vite client
# 或浏览器层——console 里的 [vite] 消息是唯一目击者，必须抓下来。
_diag: list[str] = []


def new_page(browser, console_errors: list[str]):
    from playwright.sync_api import expect

    def _on_console(msg) -> None:
        if msg.type == "error":
            console_errors.append(f"console.error: {msg.text}")
        _diag.append(f"[console.{msg.type}] {msg.text[:300]}")
        if len(_diag) > 500:
            del _diag[: len(_diag) - 500]

    def _on_nav(frame) -> None:
        if frame.parent_frame is None:
            _diag.append(f"[navigate] {frame.url}")

    def _on_pageerror(exc) -> None:
        console_errors.append(f"pageerror: {exc}")
        _diag.append(f"[pageerror] {exc}")

    expect.set_options(timeout=DEFAULT_TIMEOUT)
    context = browser.new_context(
        viewport={"width": 1440, "height": 900},
        locale="zh-CN",
        accept_downloads=True,
    )
    page = context.new_page()
    page.set_default_timeout(DEFAULT_TIMEOUT)
    page.on("console", _on_console)
    page.on("pageerror", _on_pageerror)
    page.on("crash", lambda: _diag.append("[crash] 页面渲染进程崩溃"))
    page.on("framenavigated", _on_nav)
    return context, page


def select_template(page, template_id: int) -> None:
    """工具条模板下拉选择 → 等 ready（canvas + 图例出现）。"""
    from playwright.sync_api import expect

    page.goto(FRONTEND_URL)
    template_select = page.locator("select.template-select").first
    template_select.wait_for(state="visible")
    template_select.select_option(value=str(template_id))
    page.locator(".pdf-page canvas").first.wait_for(state="visible", timeout=CANVAS_TIMEOUT)
    expect(page.locator(".legend")).to_be_visible()


def confirm_all_candidates(page, expected: int) -> None:
    """校对模式：逐个确认候选区域 → 进度 N/N → 退回正常模式（版本渲染黄框）。"""
    from playwright.sync_api import expect

    page.locator('[data-testid="proofread-toggle"]').check()
    candidates = page.locator(".pdf-page .overlay.cand-high")
    candidates.first.wait_for(state="visible")
    for _ in range(expected):
        candidates.first.click()
        page.locator('[data-testid="proofread-popover"]').wait_for(state="visible")
        page.locator('[data-testid="proofread-confirm"]').click()
        page.locator('[data-testid="proofread-popover"]').wait_for(state="hidden")
    expect(page.locator('[data-testid="proofread-progress"]')).to_have_text(
        f"已处理 {expected}/{expected}"
    )
    page.locator('[data-testid="proofread-toggle"]').uncheck()
    page.locator(".pdf-page .overlay.pending").first.wait_for(state="visible")


def create_block(page, name: str, content: str) -> None:
    """块库新建字符块（创建成功自动选中，出现正向绑定指引）。"""
    page.locator(".block-library .header button.primary").click()
    form = page.locator(".create-form")
    form.wait_for(state="visible")
    form.locator("input").first.fill(name)
    form.locator("textarea").fill(content)
    form.locator('button[type="submit"]').click()
    page.locator(".selected-tip").wait_for(state="visible")
    form.wait_for(state="hidden")


def bind_selected_block(page, region_title_prefix: str, bound_count: int) -> None:
    """正向绑定：点选块后点区域覆盖层 → 等「已绑定 N」图例。

    覆盖层着色 M7 溢出优先：绑定区域可能显示为绿（bound）或橙/红（溢出
    small/large），不能只等 .bound；图例计数按绑定状态统计，是权威信号。
    替换后 DOCX 首次 LO 转换属冷路径（内容寻址缓存必 miss），放宽到 120s。
    """
    from playwright.sync_api import expect

    page.locator(f'.pdf-page .overlay[title^="{region_title_prefix}"]').click()
    page.locator(
        '.pdf-page .overlay.bound, .pdf-page .overlay.overflow-small, '
        '.pdf-page .overlay.overflow-large'
    ).first.wait_for(state="visible", timeout=RENDER_TIMEOUT)
    expect(page.locator(".legend")).to_contain_text(
        f"已绑定 {bound_count}", timeout=RENDER_TIMEOUT
    )


# ---- 三大场景 ----

def scenario_1(browser) -> list[str]:
    """日常沉淀：上传→校对→建块→绑定→预览替换生效。"""
    errors: list[str] = []
    context, page = new_page(browser, errors)
    try:
        template_id = seed(1)[0]["id"]
        print(f"  播种模板 id={template_id}")

        select_template(page, template_id)
        confirm_all_candidates(page, expected=2)

        work_content = "负责电商平台订单模块的开发与维护"
        create_block(page, "姓名块", "张三")
        bind_selected_block(page, "姓名", bound_count=1)
        create_block(page, "工作块", work_content)
        bind_selected_block(page, "工作经历", bound_count=2)

        # 产物校验：单管线预览 PDF，占位符已被块内容替换
        result = verify_preview(template_id, expect=["张三", work_content], absent=["{{"])
        assert result["ok"], f"预览 PDF 校验失败: {result}"
    except Exception:
        page.screenshot(path=f"/tmp/e2e_fail_s1.png")
        raise
    finally:
        context.close()
    return errors


def scenario_2(browser) -> list[str]:
    """定向投递：绑定触发大超出→新建版本→版本切换→导出警示确认。"""
    errors: list[str] = []
    context, page = new_page(browser, errors)
    try:
        template_id = seed(2)[0]["id"]
        print(f"  播种模板 id={template_id}")

        select_template(page, template_id)
        confirm_all_candidates(page, expected=1)

        long_content = "\n".join(
            f"第{i}行：负责核心模块的设计与开发工作" for i in range(1, 13)
        )
        create_block(page, "长内容块", long_content)
        bind_selected_block(page, "概述", bound_count=1)

        # 大超出（固定行高裁剪 → 强制 large）：红框 + 底部状态条
        from playwright.sync_api import expect

        page.locator(".pdf-page .overlay.overflow-large").first.wait_for(state="visible")
        bar = page.locator('[data-testid="overflow-bar"]')
        expect(bar).to_be_visible()
        expect(bar).to_contain_text("大超出 1")
        expect(bar).to_contain_text(re.compile(r"概述\s*（裁剪）"))  # DOM 间隙含空白

        # 新建版本（复制当前绑定底稿）→ 自动切换
        stamp = time.strftime("%H%M%S")
        version_name = f"投递版{stamp}"
        page.locator('[data-testid="version-create"]').click()
        dialog = page.locator('[data-testid="version-dialog"]')
        dialog.wait_for(state="visible")
        dialog.locator('[data-testid="version-name-input"]').fill(version_name)
        dialog.locator('[data-testid="version-copy-checkbox"]').check()
        dialog.locator('button[type="submit"]').click()
        dialog.wait_for(state="hidden")
        version_select = page.locator('[data-testid="version-select"]')
        expect(version_select.locator("option:checked")).to_have_text(
            re.compile(f"{re.escape(version_name)}（1 项绑定）")
        )

        # 版本来回切换（M8 整体刷新）。注意：纯绑定不刷新版本下拉的 binding_count
        # （M8 既有行为，迁移/版本操作才刷新），故按选项文本子串取 value 再切。
        def _version_value(substring: str) -> str:
            option = version_select.locator("option", has_text=substring).first
            value = option.get_attribute("value")
            assert value is not None, f"版本下拉找不到含 {substring!r} 的选项"
            return value

        version_select.select_option(value=_version_value("默认版本"))
        page.locator(".pdf-page canvas").first.wait_for(state="visible", timeout=CANVAS_TIMEOUT)
        version_select.select_option(value=_version_value(version_name))
        page.locator(".pdf-page canvas").first.wait_for(state="visible", timeout=CANVAS_TIMEOUT)
        expect(bar).to_be_visible(timeout=RENDER_TIMEOUT)  # 大超出在新版本同样存在

        # 导出：大超出拦截 → 警示弹层 → 确认重排导出 → 文件名与产物校验
        page.locator('[data-testid="export-btn"]').click()
        export_dialog = page.locator('[data-testid="export-dialog"]')
        export_dialog.wait_for(state="visible")
        expect(export_dialog).to_contain_text("固定行高裁剪内容")
        with page.expect_download() as download_info:
            export_dialog.locator('[data-testid="export-confirm"]').click()
        download = download_info.value
        file_name = download.suggested_filename
        assert re.fullmatch(rf"简历-{version_name}-\d{{8}}\.docx", file_name), (
            f"导出文件名不符规则: {file_name}"
        )
        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        saved = DOWNLOAD_DIR / file_name
        download.save_as(str(saved))
        export_dialog.wait_for(state="hidden")

        result = verify_export_file(saved, expect=["第1行", "第12行"], absent=["{{"])
        assert result["ok"], f"导出产物校验失败: {result}"
    except Exception:
        page.screenshot(path="/tmp/e2e_fail_s2.png")
        raise
    finally:
        context.close()
    return errors


def scenario_3(browser) -> list[str]:
    """模板换装：源版本绑定 → 切 ready 新模板 → 迁移确认 → 绑定零重录。"""
    errors: list[str] = []
    context, page = new_page(browser, errors)
    try:
        from playwright.sync_api import expect

        source, target = seed(3)
        source_id, target_id = source["id"], target["id"]
        print(f"  播种模板 id={source_id}（源）/ id={target_id}（目标）")

        # 目标模板先校对至 ready（迁移触发守门要求目标 ready）
        select_template(page, target_id)
        confirm_all_candidates(page, expected=2)

        # 源模板建块绑定 ×2（占位符区域 pending 可绑定）
        select_template(page, source_id)
        work_content = "负责核心交易系统的研发"
        create_block(page, "姓名块S", "李四")
        bind_selected_block(page, "姓名", bound_count=1)
        create_block(page, "工作块S", work_content)
        bind_selected_block(page, "工作经历", bound_count=2)

        # 切目标模板 → 迁移弹层（prompt）→ 方案（自动匹配 2）→ 确认
        page.locator("select.template-select").first.select_option(value=str(target_id))
        migration = page.locator('[data-testid="migration-dialog"]')
        migration.wait_for(state="visible")
        expect(migration).to_contain_text("2 个绑定")
        migration.locator('[data-testid="migration-proceed"]').click()
        auto_list = migration.locator('[data-testid="migration-auto-list"]')
        auto_list.wait_for(state="visible")
        assert auto_list.locator("li.row").count() == 2, "自动匹配清单应含 2 行"
        expect(page.locator('[data-testid="migration-count"]')).to_have_text(
            "将迁移 2 个绑定"
        )
        migration.locator('[data-testid="migration-apply"]').click()
        migration.wait_for(state="hidden")

        # 绑定零重录：目标默认版本 2 项绑定 + 预览替换生效（迁移后首次替换渲染，放宽超时）
        expect(page.locator(".legend")).to_contain_text("已绑定 2", timeout=RENDER_TIMEOUT)
        version_select = page.locator('[data-testid="version-select"]')
        expect(version_select.locator("option:checked")).to_have_text(
            re.compile("默认版本（2 项绑定）"), timeout=RENDER_TIMEOUT
        )
        result = verify_preview(target_id, expect=["李四", work_content], absent=["{{"])
        assert result["ok"], f"迁移后预览 PDF 校验失败: {result}"
    except Exception:
        page.screenshot(path="/tmp/e2e_fail_s3.png")
        raise
    finally:
        context.close()
    return errors


SCENARIOS = {1: ("日常沉淀", scenario_1), 2: ("定向投递", scenario_2), 3: ("模板换装", scenario_3)}


def main() -> None:
    pick = sys.argv[1] if len(sys.argv) > 1 else "all"
    wanted = list(SCENARIOS) if pick == "all" else [int(pick)]
    if not wanted or any(n not in SCENARIOS for n in wanted):
        raise SystemExit("用法: run_e2e.py [1|2|3|all]")

    ensure_services()
    atexit.register(cleanup)

    from playwright.sync_api import sync_playwright

    results: list[tuple[str, str, list[str]]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for number in wanted:
            name, fn = SCENARIOS[number]
            print(f"\n== 场景 {number} {name} ==")
            _diag.clear()
            try:
                errors = fn(browser)
                results.append((f"场景{number} {name}", "PASS", errors))
                print(f"  PASS {name}")
            except Exception as exc:
                results.append((f"场景{number} {name}", "FAIL", [str(exc)]))
                print(f"  FAIL {name}: {exc}")
                if _diag:
                    print("  —— 诊断：console/导航/崩溃 末尾 40 条 ——")
                    for line in _diag[-40:]:
                        print(f"    {line}")
        browser.close()

    print("\n== 汇总 ==")
    failed = False
    for name, status, messages in results:
        print(f"{status}  {name}")
        for msg in messages:
            print(f"    · {msg}")
        if status == "FAIL":
            failed = True
    print("\n说明：模板/块为累加式测试数据（未清理）；下载产物在 /tmp/e2e_downloads/")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
