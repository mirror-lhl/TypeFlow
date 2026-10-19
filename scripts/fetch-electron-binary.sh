#!/usr/bin/env bash
#
# 手动安装 Electron 二进制（不依赖 electron 的 postinstall）。
#
# 为什么要绕过官方 postinstall：
#   1. 它从 GitHub Releases 拉 ~100MB，直连实测 ~75 KB/s 且频繁卡死
#   2. 它硬编码把 zip 缓存到 ~/Library/Caches/electron，而该目录在当前
#      运行环境下不可创建（EPERM），且不认 ELECTRON_CACHE 覆盖
#
# 因此本脚本做三件事，等价于官方 install.js 的行为：
#   下载 zip → 校验 SHA256 → 解压到 node_modules/electron/dist → 写 path.txt
#
# 用法：
#   ./scripts/fetch-electron-binary.sh
#   ELECTRON_VERSION=33.4.11 ./scripts/fetch-electron-binary.sh
#   ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/v ./scripts/fetch-electron-binary.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

PROXY="${PROXY:-http://127.0.0.1:7890}"
ELECTRON_VERSION="${ELECTRON_VERSION:-33.4.11}"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
CACHE_DIR="${ELECTRON_CACHE:-${TMPDIR:-/tmp}/typeflow-electron-cache}"

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "✗ 不支持的架构: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="electron-v${ELECTRON_VERSION}-darwin-${ARCH}.zip"
BASE="${ELECTRON_MIRROR%/}/${ELECTRON_VERSION}"
PROXY_OPT=(--proxy "http://${PROXY#http://}")

mkdir -p "$CACHE_DIR"
cd "$CACHE_DIR"

echo "▸ Electron  : $ELECTRON_VERSION ($ARCH)"
echo "▸ 源        : $BASE"
echo "▸ 缓存      : $CACHE_DIR"

if [ ! -s "$ASSET" ]; then
  echo "▸ 下载二进制"
  curl -fL "${PROXY_OPT[@]}" --retry 4 --retry-delay 2 --connect-timeout 20 \
    -o "$ASSET.part" "$BASE/$ASSET"
  mv "$ASSET.part" "$ASSET"
else
  echo "▸ 复用已缓存 zip"
fi
echo "  zip 大小: $(du -h "$ASSET" | cut -f1)"

echo "▸ 校验 SHA256"
curl -fsL "${PROXY_OPT[@]}" --retry 4 --connect-timeout 20 -o SHASUMS256.txt "$BASE/SHASUMS256.txt"
EXPECTED="$(grep -E "[ *]${ASSET}\$" SHASUMS256.txt | awk '{print $1}' | head -1)"
ACTUAL="$(shasum -a 256 "$ASSET" | awk '{print $1}')"
if [ -z "$EXPECTED" ]; then
  echo "✗ SHASUMS256.txt 中未找到 $ASSET" >&2; exit 1
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "✗ 校验失败，zip 可能损坏" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual  : $ACTUAL" >&2
  rm -f "$ASSET"
  exit 1
fi
echo "  ✓ 校验通过 ${ACTUAL:0:16}…"

cd - >/dev/null
TARGET="node_modules/electron"
[ -d "$TARGET" ] || { echo "✗ 未找到 $TARGET，请先运行 npm install" >&2; exit 1; }

echo "▸ 解压到 $TARGET/dist"
rm -rf "$TARGET/dist"
mkdir -p "$TARGET/dist"
unzip -q -o "$CACHE_DIR/$ASSET" -d "$TARGET/dist"

# install.js 会写入 path.txt，electron 模块据此定位可执行文件。
# 注意：内容必须是**相对 dist/ 的路径**——electron 模块内部会自己拼 dist/，
# 若这里写成 dist/Electron.app/... 会得到 dist/dist/... 的重复路径。
printf 'Electron.app/Contents/MacOS/Electron' > "$TARGET/path.txt"

BINARY="$TARGET/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$BINARY" ]; then
  echo "✗ 解压后未找到可执行文件: $BINARY" >&2
  exit 1
fi

echo "✓ Electron 就位（$(du -sh "$TARGET/dist" | cut -f1)）"
"$BINARY" --version 2>/dev/null | sed 's/^/  /' || true
