#!/usr/bin/env node
/**
 * chapter-log-parser.js — 共享的 chapter-log.md 解析器
 *
 * 统一 save-chapter / delete-chapter / sort-log 等脚本
 * 对章节块的识别规则，避免口径不一致导致的幽灵残留/重复日志。
 *
 * 导出：
 *   - chineseToNumber(str)   — 中文数字 → 阿拉伯数字
 *   - CHAPTER_HEADING_RE     — 章节标题正则（匹配 #{1,3} 前缀）
 *   - INSPECT_HEADING_RE     — 巡检标题正则
 *   - parseBlocks(content)   — 将 chapter-log 内容拆分为结构化块数组
 *   - removeChapterBlocks(content, chapterNums) — 移除指定章节编号的日志块
 *   - assembleBlocks(headerBlock, sortableBlocks) — 组装块数组为文本
 */
'use strict'

// ── 中文数字 → 阿拉伯数字 ──────────────────────────────
const CN_DIGIT = {
  '零': 0, '〇': 0,
  '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9,
  '十': 10, '百': 100, '千': 1000, '万': 10000,
}

function chineseToNumber(str) {
  if (!str) return NaN
  if (/^[0-9]+$/.test(str)) return parseInt(str, 10)
  let result = 0, current = 0, wanPart = 0
  for (const ch of str) {
    const val = CN_DIGIT[ch]
    if (val === undefined) return NaN
    if (val === 10000) {
      if (current === 0) current = 1
      wanPart = (result + current) * 10000
      result = 0; current = 0
    } else if (val >= 10) {
      if (current === 0) current = 1
      result += current * val
      current = 0
    } else {
      current = val
    }
  }
  return wanPart + result + current
}

// ── 阿拉伯数字 → 中文数字 ──────────────────────────────
function numToChinese(n) {
  const digits = ['零','一','二','三','四','五','六','七','八','九']
  function full(n) {
    if (n < 10) return digits[n]
    if (n < 100) {
      const tens = Math.floor(n / 10), ones = n % 10
      let result = `${digits[tens]}十`
      if (ones) result += digits[ones]
      return result
    }
    if (n < 1000) {
      const hundreds = Math.floor(n / 100), remainder = n % 100
      let result = `${digits[hundreds]}百`
      if (!remainder) return result
      if (remainder < 10) return `${result}零${digits[remainder]}`
      return result + full(remainder)
    }
    if (n < 10000) {
      const thousands = Math.floor(n / 1000), remainder = n % 1000
      let prefix = `${digits[thousands]}千`
      if (!remainder) return prefix
      if (remainder < 100) return `${prefix}零${full(remainder)}`
      return prefix + full(remainder)
    }
    const wan = Math.floor(n / 10000), remainder = n % 10000
    let prefix = full(wan) + '万'
    if (!remainder) return prefix
    if (remainder < 1000) return `${prefix}零${full(remainder)}`
    return prefix + full(remainder)
  }
  if (n >= 10 && n < 20) {
    const ones = n % 10
    return ones ? `十${digits[ones]}` : '十'
  }
  return full(n)
}

// ── 统一正则（所有脚本共用）──────────────────────────────
// #{1,3} 开头，匹配阿拉伯数字或中文数字章节号
const CHAPTER_HEADING_RE = /^#{1,3}\s*第(0*[0-9]+|[零一二两三四五六七八九十百千万]+)章([\s].*)?$/
const INSPECT_HEADING_RE = /^#{1,3}\s*\[巡检\]/
// 任意 ## 级别的 heading（用于判断块结束）
const ANY_HEADING_RE = /^#{1,3}\s/

/**
 * 解析 chapter-log.md 内容为结构化块数组。
 *
 * @param {string} content — 文件全文
 * @returns {{ headerBlock: object|null, blocks: object[] }}
 *   每个 block: { lines: string[], type: 'header'|'chapter'|'inspect'|'other', num: number }
 */
function parseBlocks(content) {
  const lines = content.split('\n')
  const allBlocks = []
  let currentBlock = null

  function pushBlock() {
    if (currentBlock) allBlocks.push(currentBlock)
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const chapterMatch = line.match(CHAPTER_HEADING_RE)
    const inspectMatch = INSPECT_HEADING_RE.test(line)

    // 判断是否为真正的标题行（非内文伪标题）
    const isRealHeading = (chapterMatch || inspectMatch) && (
      li === 0 ||
      (li > 0 && (lines[li - 1].trim() === '' || ANY_HEADING_RE.test(lines[li - 1]) || /^---\s*$/.test(lines[li - 1])))
    )

    if (isRealHeading) {
      pushBlock()
      if (chapterMatch) {
        const num = chineseToNumber(chapterMatch[1])
        currentBlock = { lines: [line], type: 'chapter', num: isNaN(num) ? 99999 : num }
      } else {
        currentBlock = { lines: [line], type: 'inspect', num: 99998 }
      }
    } else {
      if (!currentBlock) {
        currentBlock = { lines: [line], type: 'header', num: -1 }
      } else {
        currentBlock.lines.push(line)
      }
    }
  }
  pushBlock()

  // 分离 header 块和可排序块
  let headerBlock = null
  const blocks = []
  for (let i = 0; i < allBlocks.length; i++) {
    const b = allBlocks[i]
    if (i === 0 && b.type === 'header') {
      headerBlock = b
    } else {
      if (b.type === 'header') {
        b.type = 'other'
        b.num = 99999
      }
      blocks.push(b)
    }
  }

  return { headerBlock, blocks }
}

/**
 * 从 chapter-log 内容中移除指定章节编号的日志块。
 *
 * @param {string} content — 文件全文
 * @param {Set<number>|number[]} chapterNums — 要移除的章节编号集合
 * @returns {string} — 清理后的内容
 */
function removeChapterBlocks(content, chapterNums) {
  const numsSet = chapterNums instanceof Set ? chapterNums : new Set(chapterNums)
  const { headerBlock, blocks } = parseBlocks(content)
  const kept = blocks.filter(b => !(b.type === 'chapter' && numsSet.has(b.num)))
  return assembleBlocks(headerBlock, kept)
}

/**
 * 组装块数组为文本内容。
 *
 * @param {object|null} headerBlock
 * @param {object[]} blocks
 * @returns {string}
 */
function assembleBlocks(headerBlock, blocks) {
  const parts = []
  if (headerBlock) parts.push(headerBlock.lines.join('\n'))
  for (const block of blocks) {
    parts.push(block.lines.join('\n'))
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

module.exports = {
  chineseToNumber,
  numToChinese,
  CHAPTER_HEADING_RE,
  INSPECT_HEADING_RE,
  ANY_HEADING_RE,
  parseBlocks,
  removeChapterBlocks,
  assembleBlocks,
}
