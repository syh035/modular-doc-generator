"""M12 原生模态/焦点/分隔条浏览器回归；使用合成 props 装载真实 Vue 组件。

先运行前后端或由本脚本自动拉起；需安装 Playwright 与浏览器。
用法：python scripts/e2e/verify_modals.py [--chromium-executable /usr/bin/chromium]
单元测试使用 jsdom，背景隔离和顶层覆盖必须由真实浏览器另行验证。
"""

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright
from run_e2e import cleanup, ensure_services

region = {
    "id": 1,
    "template_id": 1,
    "label": "项目进度",
    "type": "custom",
    "review_status": "pending",
    "placeholder": "{{进度}}",
    "binding": None,
    "overflow": None,
}
cases = {
    "BindingDialog": {"region": region, "blocks": []},
    "ProofreadPopover": {"region": region},
    "RegionNameDialog": {"error": None, "submitting": False},
    "VersionDialog": {
        "mode": "create",
        "initialName": "",
        "canCopy": True,
        "error": None,
        "submitting": False,
    },
    "MigrationDialog": {
        "stage": "prompt",
        "sourceTemplateName": "上期报告",
        "sourceVersionName": "上期",
        "sourceBindingCount": 1,
        "targetTemplateName": "本期报告",
        "plan": None,
        "error": None,
        "submitting": False,
    },
    "ExportDialog": {
        "warnings": [
            {
                "region_id": i,
                "label": f"项目 {i}",
                "ratio": 1.5,
                "clipped": False,
                "fixed_row": False,
            }
            for i in range(20)
        ],
        "error": None,
        "submitting": False,
    },
}
mount_js = """async ({name, props}) => {
 const {createApp,h,ref}=await import('/node_modules/.vite/deps/vue.js');
 const component=(await import(`/src/components/${name}.vue`)).default;
 document.querySelector('#m12-opener')?.remove();
 const opener=document.createElement('button'); opener.id='m12-opener';opener.textContent='测试打开';document.body.append(opener);opener.focus();
 const host=document.createElement('div');document.body.append(host);
 const show=ref(true); window.m12Closed=0;
 const app=createApp({setup:()=>()=>show.value?h(component,{...props,onClose:()=>{window.m12Closed++;show.value=false}}):null});
 window.m12App=app;window.m12Host=host;app.mount(host);
}"""


def check(chromium_executable: str | None) -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=chromium_executable, headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto("http://localhost:5173")
        page.wait_for_selector(".app-shell")
        separator = page.get_by_role("separator", name="块库宽度")
        if not separator.is_visible():
            page.locator(".library-expand").click()
        separator.focus()
        old = int(separator.get_attribute("aria-valuenow"))
        page.keyboard.press("ArrowLeft")
        assert int(separator.get_attribute("aria-valuenow")) == max(230, old - 16)
        page.keyboard.press("ArrowRight")
        assert int(separator.get_attribute("aria-valuenow")) == min(
            360, max(230, old - 16) + 16
        )
        page.reload()
        page.wait_for_selector("[role=separator]")
        assert page.evaluate(
            "localStorage.getItem('blocks.libraryWidth')"
        ) == page.get_by_role("separator").get_attribute("aria-valuenow")
        print("PASS separator keyboard, ARIA and reload persistence", flush=True)
        for name, props in cases.items():
            page.evaluate(mount_js, {"name": name, "props": props})
            page.wait_for_selector("dialog:modal")
            geometry = page.evaluate("""() => {
    const d=document.querySelector('dialog:modal'),r=d.getBoundingClientRect();
    return {x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight,position:getComputedStyle(d).position,hit:!!document.elementFromPoint(5,5)?.closest('dialog')};
   }""")
            assert (
                geometry["x"] == 0
                and geometry["y"] == 0
                and geometry["w"] == geometry["vw"]
                and geometry["h"] == geometry["vh"]
                and geometry["position"] == "fixed"
                and geometry["hit"]
            ), geometry
            page.evaluate("document.querySelector('#m12-opener').focus()")
            assert page.evaluate(
                "document.querySelector('dialog:modal').contains(document.activeElement)"
            )
            if name in ("VersionDialog", "RegionNameDialog"):
                assert page.locator("[data-modal-autofocus]").evaluate(
                    "(e)=>e===document.activeElement"
                )
            for key in ["Tab"] * 12 + ["Shift+Tab"] * 12:
                page.keyboard.press(key)
                assert page.evaluate(
                    "document.querySelector('dialog:modal').contains(document.activeElement)"
                ), name
            if name == "VersionDialog":
                page.screenshot(path=str(Path("/tmp/m12-check/version-modal.png")))
            page.keyboard.press("Escape")
            page.wait_for_selector("dialog", state="detached")
            assert page.evaluate("window.m12Closed") == 1
            assert page.evaluate("document.activeElement.id==='m12-opener'")
            page.evaluate("window.m12App.unmount();window.m12Host.remove()")
            page.evaluate(mount_js, {"name": name, "props": props})
            page.wait_for_selector("dialog:modal")
            page.mouse.click(5, 5)
            page.wait_for_selector("dialog", state="detached")
            assert page.evaluate("window.m12Closed") == 1
            page.evaluate("window.m12App.unmount();window.m12Host.remove()")
            print(
                f"PASS {name}: native modal, full viewport, background isolation, Tab/Shift+Tab, Escape/backdrop, focus return",
                flush=True,
            )
        page.set_viewport_size({"width": 375, "height": 500})
        page.evaluate(
            mount_js, {"name": "ExportDialog", "props": cases["ExportDialog"]}
        )
        page.wait_for_selector("dialog:modal")
        assert page.locator("dialog .dialog-card").bounding_box()["height"] <= 468
        page.get_by_test_id("export-confirm").focus()
        assert page.get_by_test_id("export-confirm").is_visible()
        page.screenshot(path=str(Path("/tmp/m12-check/small-viewport.png")))
        print("PASS small viewport scrollable export dialog", flush=True)
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="M12 模态与键盘浏览器回归")
    parser.add_argument(
        "--chromium-executable",
        help="指定现有 Chromium；默认使用 Playwright 安装的版本",
    )
    args = parser.parse_args()
    Path("/tmp/m12-check").mkdir(exist_ok=True)
    try:
        ensure_services()
        check(args.chromium_executable)
    finally:
        cleanup()
