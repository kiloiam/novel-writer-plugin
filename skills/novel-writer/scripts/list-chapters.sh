#!/bin/bash
# 列出项目中现存章节（编号、文件名、字数）
# 处理标准章节：第[数字]章-标题.md 和裸文件 第[数字]章.md

set -euo pipefail
export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=en_US.UTF-8 2>/dev/null || true

chapters_dir="${1:-.}"

if [ ! -d "$chapters_dir" ]; then
  exit 0
fi

output=""
total=0
for f in "$chapters_dir"/第[0-9]*章*.md; do
  [ -f "$f" ] || continue
  basename="$(basename "$f")"
  # Skip bare .md that isn't 第X章.md or 第X章-title.md
  case "$basename" in
    第[0-9]*章.md|第[0-9]*章-*.md) ;;
    *) continue ;;
  esac
  case "$basename" in
    *.bak.md|*.bak2.md|*.rewrite-bak.md|*.rewrite-bak-2.md|*.para-bak.md) continue ;;
  esac
  num=$(echo "$basename" | sed -n 's/^第\([0-9][0-9]*\)章.*/\1/p')
  num=$(echo "$num" | sed 's/^0*//')
  [ -z "$num" ] && num=0
  chars=$(sed '/^#/d;/^---$/d;/^>/d;s/\*\*//g' "$f" | tr -d '[:space:]' | wc -m | tr -d '[:space:]')
  total=$((total + chars))
  output="${output}${num}|${basename}|${chars}\n"
done

if [ -n "$output" ]; then
  printf '%b' "$output" | sort -t'|' -k1,1n | sed '/^$/d'
fi

echo "总计|${total}"
