#!/bin/bash
# 统计项目中现存章节数量
# 用法: bash count-chapters.sh <chapters_dir>
# 输出: 数字（现存章节数）

set -euo pipefail

chapters_dir="${1:-.}"
if [ -d "$chapters_dir/chapters" ]; then
  chapters_dir="$chapters_dir/chapters"
fi

if [ ! -d "$chapters_dir" ]; then
  echo "0"
  exit 0
fi

count=0
for f in "$chapters_dir"/第[0-9]*章*.md; do
  [ -f "$f" ] || continue
  basename="$(basename "$f")"
  case "$basename" in
    第[0-9]*章.md|第[0-9]*章-*.md) ;;
    *) continue ;;
  esac
  case "$basename" in
    *.bak.md|*.bak2.md|*.rewrite-bak.md|*.rewrite-bak-2.md|*.para-bak.md) continue ;;
  esac
  count=$((count + 1))
done

echo "$count"
