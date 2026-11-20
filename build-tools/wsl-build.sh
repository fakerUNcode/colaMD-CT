#!/usr/bin/env bash
# ColaMD CT — WSL(Ubuntu-24.04) 内构建 Linux/macOS 包。
# 用法: wsl.exe -d Ubuntu-24.04 -- bash /mnt/d/workspace/colaMD-CT/ColaMD-main/build-tools/wsl-build.sh <stage>
# stage: setup | build-linux | build-mac | all
set -euo pipefail

PROJ_WIN=/mnt/d/workspace/colaMD-CT/ColaMD-main
PROJ=$HOME/colamd-ct
mkdir -p "$HOME/bin"
export PATH=$HOME/node22/bin:$HOME/bin:$PATH
export ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
export npm_config_registry=https://registry.npmmirror.com

stage="${1:-all}"

# 假 sips：dmg-builder 在 Linux 上唯一缺的 macOS 工具，用途只是读背景图尺寸
# （`sips -g pixelHeight -g pixelWidth <png>`）。用 PNG IHDR 头直接给答案。
if [ ! -x "$HOME/bin/sips" ]; then
  cat > "$HOME/bin/sips" <<'SHIM'
#!/usr/bin/env bash
python3 - "$@" <<'PY'
import struct, sys
path = sys.argv[-1]
w = h = 0
with open(path, 'rb') as f:
    head = f.read(26)
if head[:8] == b'\x89PNG\r\n\x1a\n' and head[12:16] == b'IHDR':
    w, h = struct.unpack('>II', head[16:24])
print(path)
print(f'  pixelWidth: {w}')
print(f'  pixelHeight: {h}')
PY
SHIM
  chmod +x "$HOME/bin/sips"
fi

setup() {
  if [ ! -d "$HOME/node22" ]; then
    curl -sL -o /tmp/node22.tar.xz https://registry.npmmirror.com/-/binary/node/v22.11.0/node-v22.11.0-linux-x64.tar.xz
    mkdir -p "$HOME/node22"
    tar -xJf /tmp/node22.tar.xz -C "$HOME/node22" --strip-components=1
    rm /tmp/node22.tar.xz
  fi
  node --version
  # 源码覆盖式同步：node_modules 留着，npm install 走增量
  mkdir -p "$PROJ"
  cd "$PROJ_WIN"
  tar -cf - \
    --exclude=./node_modules --exclude=./release --exclude=./dist \
    --exclude=./dist-web --exclude=./build-tools . > /tmp/ct-src.tar
  tar -xf /tmp/ct-src.tar -C "$PROJ"
  cd "$PROJ"
  npm install --no-audit --no-fund
  echo "SETUP_OK"
}

build_linux() {
  cd "$PROJ"
  npx electron-vite build
  npx electron-builder --linux AppImage deb --publish never
  ls -la release/*.AppImage release/*.deb
  cp release/*.AppImage release/*.deb "$PROJ_WIN/release/" 2>/dev/null || true
  echo "LINUX_OK"
}

build_mac() {
  # macOS 目标在非 macOS 主机上不受官方支持：zip/dir 不签名时有机会出包；
  # dmg（要 hdiutil）与签名/公证必须真 macOS，出不来就如实报告。
  # 下载在 Windows 侧做好（build-tools/electron-v44.3.0-darwin-x64.zip，
  # npmmirror 一次就成）；解压必须落 Linux 文件系统——macOS app bundle 的
  # framework 版本结构全是符号链接，NTFS/9p 上解出来就是废的。
  cd "$PROJ"
  DIST=$HOME/electron-dist-mac
  ZIP_WIN=$PROJ_WIN/build-tools/electron-v44.3.0-darwin-x64.zip
  if [ ! -d "$DIST/Electron.app" ]; then
    rm -rf "$DIST"
    python3 "$PROJ_WIN/build-tools/unzip-symlinks.py" "$ZIP_WIN" "$DIST"
  fi
  ls "$DIST"
  npx electron-vite build
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  npx electron-builder --mac zip --x64 --config.electronDist="$DIST" --publish never && echo "MAC_ZIP_OK" || echo "MAC_ZIP_UNAVAILABLE"
  ls -la release/*.zip 2>/dev/null | grep -iv linux || true
  cp release/ColaMD-CT-*-x64.zip "$PROJ_WIN/release/ColaMD-CT-mac-x64.zip" 2>/dev/null || true
}

case "$stage" in
  setup) setup ;;
  mac-dmg-pkg)
    # dmg 交叉构建：app-builder 的 dmg 制作本就是跨平台的，唯一缺口是
    # dmg-builder 借 macOS `sips` 读背景图尺寸——上面的假 sips 补齐它。
    # pkg 用 macOS 专属的 pkgbuild/productbuild，Linux 出不来（报错如实记录）。
    cd "$PROJ"
    DIST=$HOME/electron-dist-mac
    ls "$DIST" >/dev/null || { echo "electron-dist-mac 缺失，先跑 mac-dist"; exit 1; }
    npx electron-vite build
    export CSC_IDENTITY_AUTO_DISCOVERY=false
    echo "===== target=dmg ====="
    npx electron-builder --mac dmg --x64 --config.electronDist="$DIST" --publish never 2>&1 | tail -15
    echo "===== target=pkg ====="
    npx electron-builder --mac pkg --x64 --config.electronDist="$DIST" --publish never 2>&1 | tail -8
    ls -la release/*.dmg release/*.pkg 2>/dev/null || true
    cp release/*.dmg "$PROJ_WIN/release/" 2>/dev/null && echo "DMG_COPIED"
    ;;
  reinstall)
    # 被打断的 npm install 留下半残树（esbuild 二进制缺失之类），增量修不干净：
    # 整棵拔掉重装。
    cd "$PROJ"
    rm -rf node_modules
    npm install --no-audit --no-fund
    ls node_modules/esbuild/*/bin/ || echo "ESBUILD_MISSING"
    echo "REINSTALL_OK"
    ;;
  build-linux) build_linux ;;
  build-mac|mac-dist) build_mac ;;
  all) setup && build_linux && build_mac ;;
esac
