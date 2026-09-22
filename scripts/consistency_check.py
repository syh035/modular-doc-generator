"""一致性比对命令行工具（里程碑 4 手动验收：真实模板预览 PDF vs 导出重转 PDF）。

用法（仓库根目录，backend/.venv 环境）：
    backend/.venv/bin/python scripts/consistency_check.py <pdf_a> <pdf_b> [--tol 1.0] [--json]

pdf_a 为对比基准（如预览 PDF），pdf_b 为对比对象（如导出重转 PDF）。
exit 0 = 一致（页数相同且零行差异）；exit 1 = 有差异或文件不存在。
"""

import argparse
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.consistency import diff_pdfs  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="逐页文本+坐标 diff 两个 PDF（一致性专项，容差内视为一致）"
    )
    parser.add_argument("pdf_a", help="对比基准（如预览 PDF）")
    parser.add_argument("pdf_b", help="对比对象（如导出重转 PDF）")
    parser.add_argument("--tol", type=float, default=1.0, help="坐标容差（点，默认 1.0）")
    parser.add_argument("--json", action="store_true", help="输出 JSON 报告")
    args = parser.parse_args()

    for label, p in (("pdf_a", args.pdf_a), ("pdf_b", args.pdf_b)):
        if not Path(p).is_file():
            print(f"文件不存在：{label}={p}", file=sys.stderr)
            return 1

    report = diff_pdfs(args.pdf_a, args.pdf_b, args.tol)
    if args.json:
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    else:
        verdict = "一致" if report.consistent else "存在差异"
        print(
            f"页数：A={report.page_count_a} B={report.page_count_b}"
            f"（{'相同' if report.pages_equal else '不同'}）；容差 {report.coord_tol}pt"
        )
        print(f"结论：{verdict}；行差异数 = {len(report.diffs)}")
        for d in report.diffs:
            where = f"第{d.page + 1}页"
            if d.kind == "moved":
                print(
                    f"  [{d.kind}] {where}「{d.text}」位移 {d.delta}pt"
                    f"（A={d.bbox_a} → B={d.bbox_b}）"
                )
            elif d.kind == "missing":
                print(f"  [{d.kind}] {where}「{d.text}」bbox={d.bbox_a}（B 中缺失）")
            else:
                print(f"  [{d.kind}] {where}「{d.text}」bbox={d.bbox_b}（A 中没有）")
    return 0 if report.consistent else 1


if __name__ == "__main__":
    raise SystemExit(main())
