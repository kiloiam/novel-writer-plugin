#!/usr/bin/env node
/**
 * tail-log.js — 提取 chapter-log.md 中最近 N 章的日志记录
 *
 * 用法：
 *   node tail-log.js <chapter-log.md 路径> [N=5]
 *
 * 行为：
 * - 找到所有 ## 第X章 标题行（支持阿拉伯数字和中文数字）
 * - 如果总章节数 ≤ N，输出整个文件
 * - 否则输出从倒数第 N 个章节标题到文件末尾的内容
 */
const fs = require('fs')
const path = require('path')

// ── 章节标题正则 ──────────────────────────────
const CHAPTER_RE = /^#{1,3}\s*第(0*[0-9]+|[零一二两三四五六七八九十百千万]+)章([\s].*)?$/

// ── 参数解析 ──────────────────────────────
const logFile = process.argv[2]
const nChapters = Math.max(1, parseInt(process.argv[3], 10) || 5)

if (!logFile) {
  process.stderr.write('用法: node tail-log.js <log_file> [N=5]\n')
  process.exit(1)
}

const absPath = path.resolve(logFile)

if (!fs.existsSync(absPath)) {
  process.stderr.write(`日志文件不存在: ${absPath}\n`)
  process.exit(1)
}

const content = fs.readFileSync(absPath, 'utf-8')
const lines = content.split('\n')

// ── 找到所有章节标题行号（0-based） ──────────────────────────────
const chapterLineNums = []
for (let i = 0; i < lines.length; i++) {
  if (CHAPTER_RE.test(lines[i])) {
    // 防内文污染：前一行为空行/标题/分隔线，或 ## 标题本身即为强信号
    const prevLine = i > 0 ? lines[i - 1] : ''
    const prevIsEmpty = prevLine.trim() === '' || /^#{1,3}\s/.test(prevLine) || /^---\s*$/.test(prevLine)
    if (i === 0 || prevIsEmpty || /^#{1,3}\s/.test(lines[i])) {
      chapterLineNums.push(i)
    }
  }
}

// 没有章节标题或总数 ≤ N，输出整个文件
if (chapterLineNums.length === 0 || chapterLineNums.length <= nChapters) {
  process.stdout.write(content)
  process.exit(0)
}

// 取倒数第 N 个章节标题的行号
const targetIdx = chapterLineNums.length - nChapters
const startLine = chapterLineNums[targetIdx]

// 从该行到文件末尾
const tail = lines.slice(startLine).join('\n')
process.stdout.write(tail)
