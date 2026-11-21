#!/usr/bin/env bash
# ColaMD CT — 在真 macOS 上一键产出 dmg + pkg（未签名）。
# dmg 底层的 dmgbuild 绑定 PyObjC darwin 二进制、pkg 底层的 pkgbuild 是 macOS
# 专属，两者都无法在 Windows/WSL/Linux 上交叉构建——这是二进制层面的硬限制。
# 在任何一台 Mac 上跑本脚本即可（或用 .github/workflows/release.yml 走 CI）。
#
# 用法: bash build-tools/mac-build.sh   （在仓库根目录）
set -euo pipefail
cd "$(dirname "$0")/.."

# 国内网络可解注释：走 npmmirror
# export ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"
# export npm_config_registry=https://registry.npmmirror.com

export CSC_IDENTITY_AUTO_DISCOVERY=false   # 无证书 → 跳过签名/公证

npm install --no-audit --no-fund
npx electron-vite build
npx electron-builder --mac dmg pkg zip --arm64 --x64 --publish never

echo "==== 产物 ===="
ls -la release/*.dmg release/*.pkg release/*.zip 2>/dev/null
echo "未签名包首次打开：右键 .app 或 dmg 里的应用 → 打开（过一次 Gatekeeper）。"
