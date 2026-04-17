#!/bin/bash
# 按章节编号重排 chapter-log.md 中的条目
# 只将真正的章节块（## 第X章... / ## 第XXX章...）与巡检块（## [巡检] ...）视为独立块
# 排序成功后保留 .sort-bak，便于人工回退

log_file="$1"

if [ ! -f "$log_file" ]; then
  echo "ERROR: 文件不存在: $log_file" >&2
  exit 1
fi

cp "$log_file" "${log_file}.sort-bak"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

awk '
BEGIN { idx = 0; buf = "" }
function flush_block() {
  if (buf != "") {
    fname = sprintf("%s/block_%05d.txt", dir, idx)
    print buf > fname
    close(fname)
    idx++
  }
}
/^##[[:space:]]*第(0*[0-9]+|[零一二三四五六七八九十百千万]+)章([[:space:]].*)?$/ || /^##[[:space:]]*\[巡检\]/ {
  flush_block()
  buf = $0
  next
}
{
  if (buf == "") {
    buf = $0
  } else {
    buf = buf "\n" $0
  }
}
END {
  flush_block()
}
' dir="$tmp_dir" "$log_file"

header_file="$tmp_dir/block_00000.txt"
first_line=$(head -1 "$header_file" 2>/dev/null)
has_header=false
if [ -f "$header_file" ] && [[ ! "$first_line" =~ ^## ]]; then
  has_header=true
fi

sort_tmp="$tmp_dir/__sort__.tmp"
> "$sort_tmp"

for f in "$tmp_dir"/block_*.txt; do
  [ -f "$f" ] || continue
  first=$(head -1 "$f")
  if [[ "$first" =~ ^##[[:space:]]*第(0*[0-9]+)章 ]]; then
    num="${BASH_REMATCH[1]}"
    num_clean=$(echo "$num" | sed 's/^0*//')
    [ -z "$num_clean" ] && num_clean=0
    echo "${num_clean}|chapter|${f}" >> "$sort_tmp"
  elif [[ "$first" =~ ^##[[:space:]]*\[巡检\] ]]; then
    echo "99998|inspect|${f}" >> "$sort_tmp"
  elif [ "$f" = "$header_file" ] && [ "$has_header" = true ]; then
    echo "-1|header|${f}" >> "$sort_tmp"
  else
    echo "99999|other|${f}" >> "$sort_tmp"
  fi
done

output_tmp="$tmp_dir/__output__.tmp"
> "$output_tmp"
first_block=true
while IFS='|' read -r num type path; do
  if [ "$first_block" = true ]; then
    first_block=false
  else
    echo "" >> "$output_tmp"
  fi
  cat "$path" >> "$output_tmp"
done < <(sort -t'|' -k1,1n "$sort_tmp")

echo "" >> "$output_tmp"
mv "$output_tmp" "$log_file"
echo "chapter-log 已按章节编号重排序（备份保留为 ${log_file}.sort-bak）"
