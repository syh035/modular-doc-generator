# 模块化文档生成助手

[![CI](https://github.com/syh035/modular-doc-generator/actions/workflows/ci.yml/badge.svg)](https://github.com/syh035/modular-doc-generator/actions/workflows/ci.yml)
[![源码许可：MIT](https://img.shields.io/badge/Source-MIT-yellow.svg)](LICENSE)

本地 DOCX 文档编辑与内容复用工具。将模板与字符块组合成不同内容版本，在独立窗口中预览并导出 Word 文档。支持 macOS，文档处理在本机完成，无需账号。

## 下载与安装

当前为 [v1.3.0-test.3 开源测试版](https://github.com/syh035/modular-doc-generator/releases/tag/v1.3.0-test.3)，支持 macOS 14+：

| 电脑 | 下载 |
|------|------|
| Apple Silicon（M 系列） | [arm64 ZIP](https://github.com/syh035/modular-doc-generator/releases/download/v1.3.0-test.3/ModularDocGenerator-1.3.0-macOS-arm64.zip) |
| Intel | [x86_64 ZIP](https://github.com/syh035/modular-doc-generator/releases/download/v1.3.0-test.3/ModularDocGenerator-1.3.0-macOS-x86_64.zip) |

1. 下载对应架构的 ZIP，解压后将 App 放到 Applications。
2. 打开 App，按检测结果安装 Python 3.12 和 LibreOffice，再初始化应用依赖。
3. 环境就绪后直接进入工作台，无需 Node 或源码目录。应用菜单「服务管理…」（⌘,）可随时重新检测。

测试版尚无 Developer ID 签名与 Apple 公证，下载后可能被 macOS 拦截；正式签名版留待后续。安装与环境说明见 [使用指南](desktop/README.md)。

## 核心功能

以下按当前源码说明，固定标签下载包尚未包含全部 [未发布更新](CHANGELOG.md#unreleased)。

- **文稿与模板**：文稿按模板分组，新建、继续编辑、另存、重命名和删除；模板有独立浏览入口。
- **文字编辑与检查**：点击正文直接编辑，在原模板检查任务中补选遗漏区域；模板可独立检查，原件保留。
- **素材复用**：同一编辑侧栏选用或设定素材；素材库支持搜索、批量标签和删除，按文稿字段选择同步范围。
- **独立归档**：保存当时的 Word 和 PDF，归档库集中查找、查看、下载与删除；后续改稿不改变归档。
- **预览与导出**：预览与导出使用同一条文档转换管线，提供溢出提醒与 DOCX 导出。
- **撤销与排版**：支持撤销／重做、段落删除／恢复，以及可独立绑定、编辑和删除的上下插入行。

## 开始使用

导入模板 → 按需检查区域 → 新建文稿 → 点击正文编辑或选用素材 → 导出或归档。

详细操作见 [使用指南](desktop/README.md#使用流程)。问题与建议请提交到 [Issues](https://github.com/syh035/modular-doc-generator/issues)。

## 常见问题

- **需要安装什么？** Python 3.12 和 LibreOffice。App 会显示真实检测结果，并为缺失项提供安装入口；应用依赖从包内离线初始化。
- **数据保存在哪里？** `~/Library/Application Support/ModularDocGenerator/Data`。更新或移动 App 不影响数据；退出应用后复制整个数据目录即可备份。
- **哪些文字无法识别？** 当前识别 DOCX 正文和表格文字；图片中的文字、页眉页脚和文本框不在识别范围。
- **预览为什么与另一台电脑上的 Word 有差异？** 本机缺少模板字体时会发生字体替换。建议安装模板使用的字体。

## 许可与更多资料

原创源码采用 [MIT](LICENSE)；组合 App 采用 AGPL-3.0，详见 [分发说明](desktop/DISTRIBUTION.md)。[发布页](https://github.com/syh035/modular-doc-generator/releases/tag/v1.3.0-test.3)提供校验文件和对应源码。

[更新日志](CHANGELOG.md) · [开发文档](docs/README.md)
