# 开发协作与验证规范

项目特有技术规则和决策以 [AGENTS](../../AGENTS.md) 为入口；目标见 [下期规划](../product/NEXT_PLAN.md)，任务状态见 [TODO](../../TODO.md)。

## 开始与执行

- 读取适用规则、相关需求/架构、任务和最近本地交接，检查 Git 状态及相关 diff；以当前仓库核对记录。
- 区分讨论与实施授权。范围明确时持续完成实现和验证；影响产品、数据、兼容性或关键决策的问题先确认，已确认事项不重复询问。
- 简单任务直接执行，复杂任务拆解依赖与验收，持续报告重要发现与阻塞。一次保持主要目标，在模块或阶段边界交接。
- 沿用既有命名和结构，优先局部改动；移动、重命名时检查引用，保护用户已有改动，不清空数据或覆盖无关文件。
- 项目使用既有隔离 checkout；除用户要求外，不额外创建 worktree。
- 按任务需要选择可用 skill/MCP，读取其说明。可替代插件缺失时使用现有工具并说明替代与验证方式，按 AGENTS 的现行规则执行；引用工具不代表已经调用。
- Git 提交、推送、合并和发布按已有授权进行；未授权时先准备可审查结果。外部消息不自行发送。

## 文档、任务与经验

- 文档职责和权威来源见 [文档导航](../README.md)，避免复制 API 字段与任务状态。
- 文档记录实际实现、验证、进展和必要约束；产品行为或模型/接口实际改变时更新对应说明。未实施工作放入下期规划与任务池，不逐轮记录讨论过程。
- TODO 保留任务编号、依赖和验收。需要用户体验验收的结果标为待验收；已运行检查可如实记录，不等待用户才写状态。
- 非当前范围的问题经核实后记录现象、影响和优先级，不把观察或猜测写成已确认缺陷。
- 复用价值高的根因和规避方式进入 [KNOWN_ISSUES](KNOWN_ISSUES.md)；未解决问题留在任务池，避免经验文档变成缺陷列表。
- STATE.md 只保留最近实际工作、验证结果、阻塞和下一步，不累计问答和建议变更。它默认不入 Git，跨机器接续还需读取版本化文档。

## 检查入口

下列命令对应现有项目脚本和 CI，工具需已安装；运行后报告实际结果，不把命令清单视为已验证。

| 范围 | 工作目录 | 命令 |
|------|----------|------|
| 后端 lint | `backend/` | `.venv/bin/ruff check .` |
| 后端类型 | `backend/` | `.venv/bin/mypy app tests` |
| 后端测试 | `backend/` | `.venv/bin/python -m pytest -q` |
| 前端 lint | `frontend/` | `npm run lint` |
| 前端类型 | `frontend/` | `npm run typecheck` |
| 前端测试 | `frontend/` | `npm test` |
| 前端构建 | `frontend/` | `npm run build` |
| 场景 E2E | 仓库根 | `/usr/bin/python3 scripts/e2e/run_e2e.py all` |
| 模态与键盘浏览器回归 | 仓库根 | `python scripts/e2e/verify_modals.py` |
| 预览/导出比对 | 仓库根 | `backend/.venv/bin/python scripts/consistency_check.py <预览.pdf> <导出重转.pdf>` |

CI 定义见 [.github/workflows/ci.yml](../../.github/workflows/ci.yml)：后端 Python 3.12，前端 Node 22。LibreOffice 相关 pytest 在缺失工具时可能跳过，不能将跳过描述为渲染通过。E2E runner 原本使用系统 Python 的 Playwright，需另核对实际安装与浏览器。

模态回归脚本需要运行 Vite 开发服务，会在缺失时自动启动前后端并清理自己启动的进程。它使用合成 props 装载真实 Vue 弹层，验证浏览器原生背景隔离、全窗覆盖和焦点；业务流程仍由场景 E2E 验证。可加 `--chromium-executable /usr/bin/chromium` 使用环境已有浏览器，截图在 `/tmp/m12-check/`，不提交到仓库。

文档维护检查链接、引用、结构、决策和历史保留；代码验证按改动范围执行。模板、替换或渲染改动还需相关真实转换与一致性检查。失败需诊断根因，不通过削弱断言或绕过 hooks 制造通过。

原始验收流程和完成判据在下节原样保留；维护性文档改动不冒称完成了业务模块测试。启动或清理服务先识别所有者，避免结束无关进程。

## Issue 使用

[Bug 模板](../../.github/ISSUE_TEMPLATE/bug_report.yml) 用于复现、环境和预期/实际行为；[功能模板](../../.github/ISSUE_TEMPLATE/feature_request.yml) 用于场景、价值、范围与验收。关联已有 M 编号，实际创建远程 Issue 后再将编号/链接写入 TODO；不要制造尚不存在的映射。

报告问题时用脱敏或合成素材，避免上传私人文档、账号或密钥。较大的模型/API 改造先形成具体提案，不直接按功能建议实施。

## 验收测试流程约定（2026-09-18 用户定）

- 测试开始时：自动准备环境——先 `lsof -iTCP:8740/5173` 查残留进程并清理 → 起后端+前端 → curl /api/health 确认 → 用 MCP browser_use 打开页面执行测试；不等用户手动准备
- 测试完毕且用户确认后（即提交 git 时）：自动清理残存程序——kill 8740/5173 监听进程、删除临时测试文件（/tmp 脚本与产物）

## 完成判据

- 每模块：类型检查 + lint + 模块测试全绿
- v1 整体：三大场景 E2E（日常沉淀 / 定向投递 / 模板换装）+ 一致性专项（预览 PDF vs 导出重转 PDF 逐页 diff + 3–5 个真实模板人工比对）


桌面模块（macOS）补充门禁：`xcrun swift-format lint --strict desktop/*.swift`、`backend/.venv/bin/ruff check scripts/build_desktop.py scripts/test_desktop.py`、`backend/.venv/bin/mypy scripts/build_desktop.py scripts/test_desktop.py`、`python3 scripts/test_desktop.py` 和 `python3 scripts/build_desktop.py`。生命周期测试使用独立临时目录与随机回环端口，不触碰正式库；完整验收另检查原生窗口、实际服务和 LibreOffice 转换。CI 新增 macOS desktop job，远程运行结果须待推送后查看。


## 源码启动与运行数据

| 依赖 | 要求 | 说明 |
|------|------|------|
| 操作系统 | macOS | 已在本机环境验证 |
| Python | 3.11+（本机 3.12） | 仅后端 venv 使用 |
| Node.js | 22（与 CI 一致） | 前端 Vite |
| LibreOffice | 必装 | DOCX→PDF 转换引擎 |

**LibreOffice 安装**（一次性，D2）：

```sh
brew install --cask libreoffice
```

- 应用启动时自动检测：未安装时启动脚本提示安装命令，`/api/health` 返回 `available: false` 与指引，其余功能不受影响
- 首次转换可能耗时数分钟（字体配置冷缓存需扫描系统字体，含全部 CJK），属一次性成本；之后命中内容寻址缓存，毫秒级

### 启动

```sh
git clone https://github.com/syh035/modular-doc-generator.git
cd modular-doc-generator
./scripts/dev.sh
```

脚本自动完成：后端 venv 与依赖初始化（首次约 1–2 分钟，自动探测 Python 3.11+）→ 前端依赖安装 → **端口预检查**（8740/5173 被占用即报错退出）→ 启动双进程（Ctrl-C 同时结束）→ 前端就绪后**自动打开浏览器**。

浏览器访问 <http://localhost:5173>（vite 绑 localhost，勿用 127.0.0.1，见 [技术经验 P26](KNOWN_ISSUES.md)）；验证后端：`curl http://127.0.0.1:8740/api/health`。

**终端一键启动**（macOS）：双击仓库根目录的 `一键启动.command`——弹出终端窗口自动拉起前后端服务，就绪后自动打开浏览器；Ctrl-C 或关闭窗口即停止服务。脚本位置自适应：放项目根目录、`scripts/` 内或桌面均可。

手动启动（可选）：

```sh
# 后端（必须 127.0.0.1:8740）
cd backend && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8740
# 前端（另一终端）
cd frontend && npm run dev
```

### 运行数据

源码开发模式的数据位于 `data/`（已 gitignore）；下载 App 的数据位于 `~/Library/Application Support/ModularDocGenerator/Data`。**备份 = 退出应用后拷贝整个数据目录**，下表为源码模式的相对路径：

| 路径 | 内容 |
|------|------|
| `data/app.db` | SQLite（WAL 模式），全部业务数据 |
| `data/templates/` | 模板原件，落盘名 `{id}_{原文件名}` |
| `data/render_cache/` | LibreOffice 转换缓存（按内容 SHA-256 寻址，可整目录删除重建） |
| `data/exports/` | 导出 DOCX 落盘（同名覆盖不累积） |
| `data/fontconfig/` | 自产字体配置（中文渲染必需，自动生成） |
| `data/lo_profile/` | LibreOffice 独立 profile（自动生成） |

### 仓库结构

当前能力见 [应用主页](../../README.md)，下一阶段安排见 [下期规划](../product/NEXT_PLAN.md)，具体任务状态和依赖见 [任务池](../../TODO.md)。

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
├── desktop/           # 原生 macOS 独立窗口应用、环境与服务
├── scripts/           # 启动、桌面构建、一致性检查、场景 E2E
└── .github/           # CI、Bug/功能 Issue 模板
```

完整文档入口见 [文档导航](../README.md)。运行数据 `data/` 和本地交接 `STATE.md` 已被 Git 忽略。

### 自验工具

```sh
# 一致性专项：预览 PDF vs 导出重转 PDF 逐页容差 diff（exit 0 一致 / 1 差异）
backend/.venv/bin/python scripts/consistency_check.py <预览.pdf> <重转.pdf>

# 三大场景 E2E（日常沉淀 / 定向投递 / 模板换装；服务未起会自动拉起）
/usr/bin/python3 scripts/e2e/run_e2e.py all

# 单元测试
cd backend && .venv/bin/python -m pytest
cd frontend && npm run test       # vitest
```
