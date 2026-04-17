#!/bin/bash
# 提取 chapter-log.md 中最近 N 章的日志记录
# 章节标题兼容：## 第X章 / ## 第XXX章 - 标题

set -euo pipefail

log_file="$1"
n_chapters="${2:-5}"

if [ ! -f "$log_file" ]; then
  echo "日志文件不存在: $log_file" >&2
  exit 1
fi

lines=$(grep -nE '^##[[:space:]]*第(0*[0-9]+|[零一二三四五六七八九十百千万]+)章([[:space:]].*)?$' "$log_file" | cut -d: -f1 || true)

if [ -z "$lines" ]; then
  cat "$log_file"
  exit 0
fi

total_chapters=$(echo "$lines" | wc -l | tr -d '[:space:]')
if [ "$total_chapters" -le "$n_chapters" ]; then
  cat "$log_file"
  exit 0
fi

target_idx=$((total_chapters - n_chapters + 1))
start_line=$(echo "$lines" | sed -n "${target_idx}p")
tail -n +"$start_line" "$log_file"
