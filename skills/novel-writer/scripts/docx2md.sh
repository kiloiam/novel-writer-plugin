#!/bin/bash
# 将 .docx 文件转换为 Markdown 纯文本
# 用法: bash docx2md.sh <input.docx> <output.md>
# 按优先级尝试: pandoc → python → unzip+sed

input="$1"
output="$2"

if [ ! -f "$input" ]; then
  echo "ERROR: 文件不存在: $input" >&2
  exit 1
fi

if [ -z "$output" ]; then
  echo "ERROR: 缺少输出路径" >&2
  echo "用法: bash docx2md.sh <input.docx> <output.md>" >&2
  exit 1
fi

# 找到可用的 python 命令（Windows 下 python3 可能是 Store stub）
PYTHON=""
for cmd in python3 python; do
  if command -v "$cmd" >/dev/null 2>&1 && "$cmd" -c "import sys; sys.exit(0)" 2>/dev/null; then
    PYTHON="$cmd"
    break
  fi
done

if command -v pandoc >/dev/null 2>&1; then
  pandoc -f docx -t markdown --wrap=none "$input" -o "$output" 2>/dev/null
  if [ $? -eq 0 ]; then
    echo "已使用 pandoc 转换"
    exit 0
  fi
fi

if [ -n "$PYTHON" ]; then
  "$PYTHON" -c "
import zipfile, re, sys
try:
    with zipfile.ZipFile(sys.argv[1]) as z:
        xml = z.read('word/document.xml').decode('utf-8')
        paragraphs = re.findall(r'<w:p[^>]*>(.*?)</w:p>', xml, re.DOTALL)
        lines = []
        for p in paragraphs:
            texts = re.findall(r'<w:t[^>]*>(.*?)</w:t>', p)
            line = ''.join(texts)
            lines.append(line)
        with open(sys.argv[2], 'w', encoding='utf-8') as f:
            f.write('\n\n'.join(line for line in lines if line.strip()))
            f.write('\n')
    print('已使用 python 转换')
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr)
    sys.exit(1)
" "$input" "$output"
  exit $?
fi

# Fallback: unzip + XML 标签剥离（会丢失格式，但能提取文本）
if command -v unzip >/dev/null 2>&1; then
  unzip -p "$input" word/document.xml 2>/dev/null | \
    sed 's/<\/w:p>/\n/g' | \
    sed 's/<[^>]*>//g' | \
    sed '/^[[:space:]]*$/d' > "$output"
  echo "已使用 unzip 转换（纯文本，格式可能丢失）"
  exit 0
fi

echo "ERROR: 无法转换 .docx，请安装 pandoc 或 python" >&2
exit 1
