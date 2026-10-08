# 前端开发入口

Vue 3 + TypeScript + Pinia + Vite，使用 pdfjs 展示后端生成的 PDF。界面与绑定状态在 `src/components/` 和 `src/stores/`，请求在 `src/api/`，PDF 渲染与坐标换算在 `src/pdf/`。

完整安装和双服务启动见 [项目 README](../README.md)，规则见 [AGENTS](../AGENTS.md)，架构见 [OVERVIEW](../docs/architecture/OVERVIEW.md)，检查命令见 [开发规范](../docs/development/WORKFLOW.md)。

在本目录执行 `npm ci`，开发执行 `npm run dev`。Vite 将 `/api` 代理到 `127.0.0.1:8740`，后端需要同时运行。

类型、lint、测试与构建分别使用 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`。Node 版本按包 engines/锁文件确定，现有 CI 使用 Node 22。
