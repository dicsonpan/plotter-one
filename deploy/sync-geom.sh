#!/bin/sh
# 把服务端几何内核同步到前端。
#
# 为什么需要：前端画布必须与服务端 CAM 用同一份几何实现，
# 否则会出现「屏幕上在这里、刻出来在那里」的错位——这种错肉眼在预览
# 阶段未必能发现，上机就晚了。两份代码各自演化必然会漂。
#
# 用法：sh deploy/sync-geom.sh

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/server/geom/path.js"
DST="$ROOT/web/geom.js"

cat "$SRC" > "$DST"

node --check "$DST"
echo "✓ 已同步 $SRC → $DST"
echo "  （前端用 <script type=\"module\"> 直接 import，web/ 是服务端 geom 的原样副本）"
