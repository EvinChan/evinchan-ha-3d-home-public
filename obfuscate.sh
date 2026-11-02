#!/usr/bin/env bash
#
# 用 PyArmor 混淆集成内的 Python 后端，生成「防护版」发布包。
#
# ⚠️ 关键约束：PyArmor 的运行时(pyarmor_runtime) 是按【操作系统 + Python 版本】
# 编译的。务必在与你目标 HA 完全相同的环境里运行本脚本（推荐 Linux / HAOS 容器，
# 且 Python 版本与 HA 一致），否则生成的产物在用户 HA 上会 import 失败。
# 本机(macOS)生成的产物不能直接发布到 HAOS(Linux)。
#
# 用法：
#   在目标环境的仓库根执行：  bash obfuscate.sh
#   脚本会把 custom_components/evinchan_ha_3d_home/ 下所有 .py 替换为混淆版，
#   并附带 pyarmor_runtime。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$ROOT/custom_components/evinchan_ha_3d_home"

if ! command -v pyarmor >/dev/null 2>&1; then
  echo "· 未找到 pyarmor，尝试安装…"
  python3 -m pip install pyarmor
fi

echo "· 当前 Python: $(python3 --version 2>&1)"
echo "· 混淆目标: $PKG"

# 递归混淆包内所有 .py；-O 指定输出目录（此处直接覆盖原包），
# --recursive 保持目录结构，运行时一并写入 PKG/pyarmor_runtime。
pyarmor gen -O "$PKG" --recursive "$PKG"

echo "✓ 混淆完成：$PKG 内 .py 已替换为混淆版，并附带 pyarmor_runtime。"
echo "· 发布前请在本环境用与目标 HA 相同的 Python 实测 import 通过后再上传。"
