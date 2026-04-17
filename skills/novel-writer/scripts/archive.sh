#!/bin/bash
# 归档章节文件到 _history 或 _deleted
# 默认强保证正文快照；是否补充元数据 sidecar 由调用流程决定

source_file="$1"
archive_type="$2"
chapters_dir="${3:-.}"
chapters_dir="${chapters_dir%/}"

if [ ! -f "$source_file" ]; then
  echo "ERROR: 源文件不存在: $source_file" >&2
  exit 1
fi

if [ -z "$archive_type" ]; then
  echo "ERROR: 请指定归档类型 (polish|rewrite|paragraph|replace|restore|deleted|write)" >&2
  exit 1
fi

case "$archive_type" in
  polish|rewrite|paragraph|replace|restore|deleted|write) ;;
  *) echo "ERROR: 无效的归档类型: $archive_type（允许值: polish|rewrite|paragraph|replace|restore|deleted）" >&2; exit 1 ;;
esac

timestamp=$(date +%Y%m%d-%H%M%S)-$(node -e "process.stdout.write(String(Date.now()%1000).padStart(3,'0'))")
basename_full="$(basename "$source_file" .md)"

if [ "$archive_type" = "deleted" ]; then
  target_dir="${chapters_dir}/_deleted"
else
  target_dir="${chapters_dir}/_history"
fi

mkdir -p "$target_dir"
archive_name="${basename_full}--${timestamp}--${archive_type}.md"
target_path="${target_dir}/${archive_name}"
cp "$source_file" "$target_path"

if [ $? -eq 0 ]; then
  echo "$target_path"
  # For deleted chapters, try to extract and save the chapter-log entry as sidecar
  if [ "$archive_type" = "deleted" ]; then
    chapter_num=$(echo "$basename_full" | sed -n 's/^第\([0-9]*\)章.*/\1/p')
    # Strip leading zeros so awk regex /^## 第0*5章/ matches both 第5章 and 第005章
    chapter_num=$(echo "$chapter_num" | sed 's/^0*//')
    [ -z "$chapter_num" ] && chapter_num=0
    log_file="${chapters_dir}/../chapter-log.md"
    if [ -n "$chapter_num" ] && [ -f "$log_file" ]; then
      log_entry_file="${target_dir}/${basename_full}--${timestamp}--log-entry.md"
      # Extract the log entry block for this chapter
      # Supports both Arabic (## 第5章) and zero-padded (## 第005章) headings
      awk '
        BEGIN { found=0 }
        /^## 第0*'"$chapter_num"'章/ { found=1 }
        found && /^## / && !/^## 第0*'"$chapter_num"'章/ { found=0 }
        found { print }
      ' "$log_file" > "$log_entry_file" 2>/dev/null
      # If Arabic match failed, try matching Chinese numeral heading via node one-liner
      if [ ! -s "$log_entry_file" ] && command -v node >/dev/null 2>&1; then
        node -e "
          const fs=require('fs'),n=$chapter_num,lines=fs.readFileSync(process.argv[1],'utf8').split('\\n');
          const CN={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'百':100,'千':1000,'万':10000};
          function c2n(s){if(/^\d+$/.test(s))return+s;let r=0,c=0,w=0;for(const ch of s){const v=CN[ch];if(v===undefined)return-1;if(v===10000){if(!c)c=1;w=(r+c)*10000;r=0;c=0}else if(v>=10){if(!c)c=1;r+=c*v;c=0}else c=v}return w+r+c}
          let out=[],found=false;
          for(const l of lines){const m=l.match(/^##\s*第(.+?)章/);if(m){const num=c2n(m[1]);if(num===n)found=true;else if(found)break};if(found)out.push(l)}
          if(out.length)fs.writeFileSync(process.argv[2],out.join('\\n')+'\\n')
        " "$log_file" "$log_entry_file" 2>/dev/null
      fi
      if [ ! -s "$log_entry_file" ]; then
        rm -f "$log_entry_file"
      fi
    fi
  fi
else
  echo "ERROR: 归档失败" >&2
  exit 1
fi
