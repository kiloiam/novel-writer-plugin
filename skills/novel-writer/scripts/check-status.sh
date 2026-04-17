#!/bin/bash
# 快速扫描项目元数据状态，为建议引擎提供信号

set -euo pipefail

project_dir="${1:-.}"
chapters_dir="${project_dir}/chapters"

chapter_count=0
if [ -d "$chapters_dir" ]; then
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
    chapter_count=$((chapter_count + 1))
  done
fi
echo "chapter_count=${chapter_count}"

if [ -f "$project_dir/outline/大纲.md" ]; then
  echo "has_outline=true"
else
  echo "has_outline=false"
fi

wb_count=0
if [ -d "$project_dir/worldbuilding" ]; then
  for f in "$project_dir/worldbuilding"/*.md; do
    [ -f "$f" ] || continue
    wb_count=$((wb_count + 1))
  done
fi
echo "worldbuilding_count=${wb_count}"

if [ -f "$project_dir/relationships.md" ]; then
  echo "has_relationships=true"
else
  echo "has_relationships=false"
fi

last_inspect_line=$(grep -n '^## \[巡检\]' "$project_dir/chapter-log.md" 2>/dev/null | tail -1 | cut -d: -f1 || true)
if [ -n "$last_inspect_line" ]; then
  chapters_since=$(tail -n +"$((last_inspect_line + 1))" "$project_dir/chapter-log.md" | grep -cE '^## 第0*[0-9]+章( - .*)?$')
  echo "chapters_since_inspect=${chapters_since}"
else
  echo "chapters_since_inspect=${chapter_count}"
fi

overdue_foreshadowing=0
if [ -f "$project_dir/foreshadowing.md" ]; then
  max_chapter=$chapter_count
  active_section=$(awk '
    /^#{1,6}[[:space:]]/ {
      if ($0 ~ /已揭示|已废弃|已放弃/) exit
    }
    { print }
  ' "$project_dir/foreshadowing.md" 2>/dev/null || true)
  if [ -n "$active_section" ]; then
    # 动态检测"埋设章节"所在列号（不硬编码列位置）
    planted_col=$(echo "$active_section" | grep '^|' | head -1 | awk -F'|' '{
      for (i=2; i<=NF; i++) {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i)
        if ($i ~ /埋设/) { print i; exit }
      }
    }' || echo "0")
    if [ -z "$planted_col" ] || [ "$planted_col" = "0" ]; then
      planted_col=0
    fi
    if [ "$planted_col" -gt 0 ]; then
      while read -r planted_num; do
        [ -z "$planted_num" ] && continue
        num_clean=$(echo "$planted_num" | sed 's/^0*//')
        [ -z "$num_clean" ] && num_clean=0
        gap=$((max_chapter - num_clean))
        if [ "$gap" -gt 10 ]; then
          overdue_foreshadowing=$((overdue_foreshadowing + 1))
        fi
      done < <(echo "$active_section" | grep '^|' | grep -v '^|.*---' | tail -n +2 | awk -F'|' -v col="$planted_col" '{print $col}' | grep -oE '[0-9]+' 2>/dev/null || true)
    fi
  fi
fi
echo "overdue_foreshadowing=${overdue_foreshadowing}"

character_count=0
if [ -d "$project_dir/characters" ]; then
  for f in "$project_dir/characters"/*.md; do
    [ -f "$f" ] || continue
    character_count=$((character_count + 1))
  done
fi
echo "character_count=${character_count}"
