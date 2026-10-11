# 开源测试 App 分发说明

项目原创源码继续按仓库 LICENSE 的 MIT 条款提供。包含 PyMuPDF／MuPDF 的组合 App 按 GNU AGPL-3.0 分发；许可全文见 LICENSE-AGPL-3.0.txt，第三方许可见 ThirdPartyLicenses，原始 wheel 也保留其许可文件。

App 对应项目源码、锁定依赖和构建脚本随 GitHub 测试 Release 的 ProjectSource.tar.gz 提供；PyMuPDF 和 MuPDF 的对应上游源码作为独立 source.tar.gz 附件提供。下载页：https://github.com/syh035/modular-doc-generator/releases 。重建步骤见源码 desktop/README.md，Python 依赖版本见 requirements-release.txt，前端依赖版本见源码 frontend/package-lock.json。

Python 与 LibreOffice 由使用者从官方网站独立安装，本包不分发它们的运行时。测试包使用 ad-hoc 本地签名，尚未获得 Developer ID 签名与 Apple 公证；不能保证从互联网下载后双击通过 Gatekeeper。应用不修改系统安全设置。
