#!/bin/bash
# 整合全书章节：将所有正文按顺序拼接为一个完整的发布版 Markdown
# 整合正式章节：第[数字]章-标题.md 和裸文件 第[数字]章.md

set -euo pipefail

project_dir="${1:-.}"
chapters_dir="${project_dir}/chapters"
output_file="${project_dir}/发布版.md"

if [ ! -d "$chapters_dir" ]; then
  echo "ERROR: 章节目录不存在: $chapters_dir" >&2
  exit 1
fi

echo "开始整合章节: $output_file"

separator="<!-- CHAPTERS_START -->"
if [ -f "$output_file" ]; then
  sep_line=$(grep -n "$separator" "$output_file" | head -1 | cut -d: -f1)
  if [ -z "$sep_line" ]; then
    echo "ERROR: 发布版缺少 ${separator} 分隔符，已停止整合。" >&2
    exit 2
  fi
  total_lines=$(wc -l < "$output_file" | tr -d '[:space:]')
  if [ "$total_lines" -gt "$sep_line" ]; then
    tail -n +"$((sep_line + 1))" "$output_file" > "${output_file}.prev-body"
    echo "已备份旧正文到 ${output_file}.prev-body" >&2
  fi
  head -n "$sep_line" "$output_file" > "${output_file}.tmp"
  mv "${output_file}.tmp" "$output_file"
else
  default_title="$(basename "$(realpath "$project_dir")")"
  [ -z "$default_title" ] && default_title="发布版"
  printf '# %s\n\n%s\n' "$default_title" "$separator" > "$output_file"
  echo "WARNING: 发布版文件不存在，已创建最小头部: $output_file" >&2
fi

sort_tmp=$(mktemp "${chapters_dir%/}/__compile_sort__.XXXXXX")
trap 'rm -f "$sort_tmp"' EXIT

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
  num=$(echo "$basename" | sed -n 's/^第\([0-9][0-9]*\)章.*/\1/p' | sed 's/^0*//')
  [ -z "$num" ] && num=0
  echo "${num}|${f}" >> "$sort_tmp"
done

while IFS='|' read -r num path; do
  basename="$(basename "$path")"
  echo "合并: $basename"
  cat "$path" >> "$output_file"
  printf '\n\n' >> "$output_file"
done < <(sort -t'|' -k1,1n "$sort_tmp")

echo "整合完成！"
