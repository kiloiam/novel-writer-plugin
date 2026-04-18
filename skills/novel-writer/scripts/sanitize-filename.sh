#!/bin/bash
# 净化文件名：替换不安全字符，确保跨平台兼容
# 用法: bash sanitize-filename.sh "原始名称" [目标目录（可选，用于去重检测）]
# 输出: 净化后的安全文件名（不含扩展名）
#
# 规则：
#   - 替换 \ / : * ? " < > |、$、` 以及常见中文危险标点（：？！【】（））为 -
#   - 替换控制字符（换行、制表、回车等）为 -
#   - 去除首尾空格和点
#   - 连续 - 折叠为一个
#   - 拒绝 Windows 保留名（CON, PRN, AUX, NUL, COM1-9, LPT1-9）
#   - 限制长度不超过 80 字符
#   - 可选：目标目录去重（追加 -2, -3 等后缀）
#   - 空结果回退为 "unnamed"

input="$1"
target_dir="$2"

if [ -z "$input" ]; then
  echo "unnamed"
  exit 0
fi

# 替换控制字符（\x00-\x1F, \x7F）为 -
result=$(printf '%s' "$input" | tr '\000-\037\177' '-')
# 替换不安全字符为 -
result=$(echo "$result" | sed 's/[\\/:*?"<>|$`：？！【】（）]/-/g')
# 去除首尾空格和点
result=$(echo "$result" | sed 's/^[[:space:].]*//;s/[[:space:].]*$//')
# 连续 - 折叠为一个
result=$(echo "$result" | sed 's/-\{2,\}/-/g')
# 去除首尾 -
result=$(echo "$result" | sed 's/^-*//;s/-*$//')

# 空结果回退
if [ -z "$result" ]; then
  result="unnamed"
fi

# Windows 保留名检测（不区分大小写）
upper=$(echo "$result" | tr '[:lower:]' '[:upper:]')
case "$upper" in
  CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])
    result="_${result}"
    ;;
esac

# 长度限制：使用 node 安全截断到 120 字节（不切断 UTF-8 字符）
byte_count=$(printf '%s' "$result" | wc -c | tr -d '[:space:]')
if [ "$byte_count" -gt 120 ]; then
  result=$(node -e "
    const s = process.argv[1];
    const buf = Buffer.from(s, 'utf8');
    if (buf.length <= 120) { process.stdout.write(s); }
    else {
      let end = 120;
      while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
      process.stdout.write(buf.slice(0, end).toString('utf8'));
    }
  " "$result")
  result=$(echo "$result" | sed 's/-*$//')
fi

# 再次检查空结果
if [ -z "$result" ]; then
  result="unnamed"
fi

# 目标目录去重
if [ -n "$target_dir" ] && [ -d "$target_dir" ]; then
  base="$result"
  counter=2
  while [ -e "${target_dir}/${result}.md" ] || [ -e "${target_dir}/${result}" ]; do
    result="${base}-${counter}"
    counter=$((counter + 1))
  done
fi

echo "$result"
