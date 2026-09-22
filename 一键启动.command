#!/bin/bash
# 模块化文档生成助手——一键启动（macOS 双击运行；Ctrl-C 停止服务并关闭）
# 位置自适应：项目根目录、scripts/ 内、或拖到桌面后按默认安装路径探测
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/dev.sh" ]; then
  ROOT="$DIR/.."
elif [ -f "$DIR/scripts/dev.sh" ]; then
  ROOT="$DIR"
elif [ -d "$HOME/Documents/trae_projects/简历助手" ]; then
  ROOT="$HOME/Documents/trae_projects/简历助手"
else
  echo "未找到项目：请将本文件放回项目根目录，或修改本脚本中的默认路径。"
  read -r -p "按回车关闭窗口"
  exit 1
fi
cd "$ROOT" || exit 1
exec ./scripts/dev.sh
