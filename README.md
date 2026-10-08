# 模块化文档生成助手

[![CI](https://github.com/syh035/modular-doc-generator/actions/workflows/ci.yml/badge.svg)](https://github.com/syh035/modular-doc-generator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB)
![Node](https://img.shields.io/badge/Node-18%2B-339933)
![Vue](https://img.shields.io/badge/Vue-3-4FC08D)

跑在个人电脑上的 Word 文档内容资产管理器（产品名「模块化文档生成助手」）：个人文字内容（简历为主场景，任意 Word 文档皆可）沉淀为「字符块」内容资产库，任意 DOCX 模板上传解析出可替换区域，点选绑定、多版本组合，导出与模板样式一致的 DOCX。

单机单人、无账号体系、数据全本地、零联网——服务只绑 `127.0.0.1`，日志不打印简历内容。

## 功能总览

**内容资产库**

- 字符块（名称 + 多行内容 + 标签）沉淀复用；软删除；被引用块删除后相关绑定置缺失态

**模板导入与解析**

- DOCX 上传解析 `{{字段名}}` 占位符 + 常见字段词表启发式 + 成段正文识别（置信度分级）
- 同内容重传自动关联（SHA-256 指纹）
- 校对：候选确认 / 排除、预览拖拽框选新建、边界微调

**绑定、预览与导出**

- 点选绑定，预览局部刷新；预览与导出共用同一条「DOCX → LibreOffice → PDF」管线（样式一致性立身之本）
- 版本管理：同模板多版本（空白 / 复制当前为底稿）、重命名、删除保护
- 换模板迁移：同类型区域按文档流顺序自动匹配，三类清单确认，绑定零重录
- 溢出检测：超出原高度 50% 分级警示（橙 = 小超出 / 红 = 大超出或固定行高裁剪），大超出导出前弹警示清单确认
- 导出：与预览同源 DOCX，文件名「简历-{版本名}-{日期}.docx」，未绑定区域保留模板原文

## 环境要求

| 依赖 | 要求 | 说明 |
|------|------|------|
| 操作系统 | macOS | 已在本机环境验证 |
| Python | 3.11+（本机 3.12） | 仅后端 venv 使用 |
| Node.js | 18+（本机 24） | 前端 Vite |
| LibreOffice | 必装 | DOCX→PDF 转换引擎 |

**LibreOffice 安装**（一次性，D2）：

```sh
brew install --cask libreoffice
```

- 应用启动时自动检测：未安装时启动脚本提示安装命令，`/api/health` 返回 `available: false` 与指引，其余功能不受影响
- 首次转换可能耗时数分钟（字体配置冷缓存需扫描系统字体，含全部 CJK），属一次性成本；之后命中内容寻址缓存，毫秒级

## 快速开始

```sh
git clone https://github.com/syh035/modular-doc-generator.git
cd modular-doc-generator
./scripts/dev.sh
```

脚本自动完成：后端 venv 与依赖初始化（首次约 1–2 分钟，自动探测 Python 3.11+）→ 前端依赖安装 → **端口预检查**（8740/5173 被占用即报错退出）→ 启动双进程（Ctrl-C 同时结束）→ 前端就绪后**自动打开浏览器**。

浏览器访问 <http://localhost:5173>（vite 绑 localhost，勿用 127.0.0.1，见 [技术经验 P26](docs/development/KNOWN_ISSUES.md)）；验证后端：`curl http://127.0.0.1:8740/api/health`。

**桌面一键启动**（macOS）：双击仓库根目录的 `一键启动.command`——弹出终端窗口自动拉起前后端服务，就绪后自动打开浏览器；Ctrl-C 或关闭窗口即停止服务。脚本位置自适应：放项目根目录、`scripts/` 内或桌面均可。

手动启动（可选）：

```sh
# 后端（必须 127.0.0.1:8740）
cd backend && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8740
# 前端（另一终端）
cd frontend && npm run dev
```

## 数据目录

运行时数据全部在 `data/`（已 gitignore），**备份 = 拷贝整个目录**：

| 路径 | 内容 |
|------|------|
| `data/app.db` | SQLite（WAL 模式），全部业务数据 |
| `data/templates/` | 模板原件，落盘名 `{id}_{原文件名}` |
| `data/render_cache/` | LibreOffice 转换缓存（按内容 SHA-256 寻址，可整目录删除重建） |
| `data/exports/` | 导出 DOCX 落盘（同名覆盖不累积） |
| `data/fontconfig/` | 自产字体配置（中文渲染必需，自动生成） |
| `data/lo_profile/` | LibreOffice 独立 profile（自动生成） |

## 使用流程

1. **导入模板**：顶栏「导入模板」选 .docx → 自动解析出候选区域并选中新模板
2. **校对**：状态栏开启校对模式 → 确认 / 排除候选、拖拽框选新建、边界微调；全部处理完模板自动转「可用」
3. **建块绑定**：左缘展开字符块库 → 新建块 → 点选块、点预览上的区域完成绑定（或区域浮层反向绑定）
4. **版本与导出**：预览工具条版本控件新建 / 切换 / 重命名 / 删除版本 →「导出 DOCX」下载

## 仓库结构与下期规划

当前能力见上方功能总览，下一阶段安排见 [下期规划](docs/product/NEXT_PLAN.md)，具体任务状态和依赖见 [任务池](TODO.md)。

```text
modular-doc-generator/
├── README.md / AGENTS.md / TODO.md / CHANGELOG.md
├── docs/
│   ├── README.md
│   ├── product/       # 原始需求、下期规划
│   ├── architecture/  # 当前架构和必要设计
│   └── development/   # 开发规范、技术经验和历史
├── backend/           # FastAPI、SQLite、业务服务与测试
├── frontend/          # Vue 工作台与 PDF 预览
├── scripts/           # 启动、一致性检查、场景 E2E
└── .github/           # CI、Bug/功能 Issue 模板
```

完整文档入口见 [docs/README.md](docs/README.md)。运行数据 `data/` 和本地交接 `STATE.md` 已被 Git 忽略。

## 自验工具（开发 / 回归）

```sh
# 一致性专项：预览 PDF vs 导出重转 PDF 逐页容差 diff（exit 0 一致 / 1 差异）
backend/.venv/bin/python scripts/consistency_check.py <预览.pdf> <重转.pdf>

# 三大场景 E2E（日常沉淀 / 定向投递 / 模板换装；服务未起会自动拉起）
/usr/bin/python3 scripts/e2e/run_e2e.py all

# 单元测试
cd backend && .venv/bin/python -m pytest
cd frontend && npm run test       # vitest
```

## 常见问题

- **启动报「端口已被占用」**：`lsof -iTCP:8740` / `lsof -iTCP:5173` 找到残留进程 kill 后重启（端口固定不可改，见架构约定）
- **首次预览很慢**：LibreOffice 冷启动 + 字体配置冷缓存，一次性；之后命中缓存毫秒级
- **中文渲染空白**：确认 LibreOffice 已安装（cask 版）；本产品已内置字体配置自产逻辑，正常无需手动处理
- **预览与 Word 原机效果有字体差异**：一致性口径指「本产品预览 = 本产品导出」（同一管线产物）；模板字体本机未装时发生字体替换属预期
- **导入模板报损坏 / 加密**：损坏 zip、加密 DOCX、纯图片模板（无文本层）均明确拒绝并提示，不支持人工修复

## 项目文档

| 文档 | 内容 |
|------|------|
| [文档导航](docs/README.md) | 分类、阅读入口与权威来源 |
| [AGENTS.md](AGENTS.md) | 核心规则、D1—D13 及文档维护原则 |
| [TODO.md](TODO.md) | 当前任务、M12—M26 及依赖 |
| [下期规划](docs/product/NEXT_PLAN.md) | 下一阶段目标、范围与验收 |
| [原始 PRD](docs/product/PRD.md) | v1.0 初始需求全文，原样保留 |
| [架构总览](docs/architecture/OVERVIEW.md) | 当前实现与能力边界 |
| [开发规范](docs/development/WORKFLOW.md) | 协作、验证与交接 |
| [技术经验](docs/development/KNOWN_ISSUES.md) | P1—P27 技术陷阱与状态备注 |
| [交付历史](docs/development/history/V1_DELIVERY.md) | 已完成任务和已解决记录 |
| [CHANGELOG.md](CHANGELOG.md) | 发布历史 |

## License

[MIT](LICENSE)
