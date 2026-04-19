/**
 * text-utils.js — 统一文本规范化工具
 *
 * 所有写入项目文件的脚本都应调用 normalizeText() 处理输入文本。
 * 确保存储层一致性：LF 换行、无 BOM、UTF-8。
 */

const fs = require('fs')

/**
 * 规范化文本用于存储
 * - \r\n → \n（Windows CRLF）
 * - \r → \n（旧 Mac CR）
 * - 去除 UTF-8 BOM（\uFEFF）
 * @param {string} text 原始文本
 * @returns {string} 规范化后的文本
 */
function normalizeText(text) {
  if (text == null) return ''
  if (typeof text !== 'string') return String(text)
  return text
    .replace(/\uFEFF/g, '')     // UTF-8 BOM
    .replace(/\r\n/g, '\n')     // Windows CRLF
    .replace(/\r/g, '\n')       // 旧 Mac CR
}

function validateUtf8Buffer(buf) {
  const start = (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? 3 : 0
  let i = start
  let invalidByteOffset = -1

  while (i < buf.length) {
    const b = buf[i]
    if (b <= 0x7F) { i++; continue }
    let expectedCont = 0
    if ((b & 0xE0) === 0xC0) expectedCont = 1
    else if ((b & 0xF0) === 0xE0) expectedCont = 2
    else if ((b & 0xF8) === 0xF0) expectedCont = 3
    else { invalidByteOffset = i; break }
    if (i + expectedCont >= buf.length) { invalidByteOffset = i; break }
    for (let j = 1; j <= expectedCont; j++) {
      if ((buf[i + j] & 0xC0) !== 0x80) { invalidByteOffset = i; break }
    }
    if (invalidByteOffset >= 0) break
    i += 1 + expectedCont
  }

  return {
    ok: invalidByteOffset < 0,
    invalidByteOffset,
    invalidByte: invalidByteOffset >= 0 ? buf[invalidByteOffset] : null,
  }
}

function readUtf8TextChecked(filePath) {
  const buf = fs.readFileSync(filePath)
  const validation = validateUtf8Buffer(buf)
  if (!validation.ok) {
    const err = new Error(`文件编码不是 UTF-8: ${filePath}（偏移 ${validation.invalidByteOffset} 处发现非法字节 0x${validation.invalidByte.toString(16)}）`)
    err.code = 'INVALID_UTF8'
    err.invalidByteOffset = validation.invalidByteOffset
    err.invalidByte = validation.invalidByte
    throw err
  }
  return normalizeText(buf.toString('utf8'))
}

function countRegexMatches(text, regex) {
  const matches = text.match(regex)
  return matches ? matches.length : 0
}

function analyzeNovelLikeContent(text, opts = {}) {
  const kind = opts.kind === 'metadata' ? 'metadata' : 'chapter'
  const normalized = normalizeText(text)
  const trimmed = normalized.trim()
  const lower = trimmed.toLowerCase()
  const lines = trimmed ? trimmed.split('\n') : []
  const nonEmptyLines = lines.filter(line => line.trim())
  const proseChars = countRegexMatches(trimmed, /[\u4e00-\u9fffA-Za-z]/g)
  const headingLines = countRegexMatches(trimmed, /^#{1,6}\s/mg)
  const bulletLines = countRegexMatches(trimmed, /^\s*[-*+]\s/mg)
  const numberedLines = countRegexMatches(trimmed, /^\s*\d+[.)、]\s/mg)
  const rolePrefixLines = countRegexMatches(trimmed, /^\s*(user|assistant|system)\s*:/img)
  const logPrefixLines = countRegexMatches(trimmed, /^\s*(error|warning|warn|info|traceback|npm err!|pnpm|node:internal)\b/img)
  const keyValueLines = countRegexMatches(trimmed, /^\s*[^\n:]{1,40}:\s+.+$/mg)
  const codeFenceCount = countRegexMatches(trimmed, /```/g)
  const htmlTagCount = countRegexMatches(trimmed, /<\/?[a-z][^>]*>/ig)
  const strongBadSignals = []
  const warnSignals = []

  if (!trimmed) {
    return {
      level: kind === 'chapter' ? 'block' : 'warn',
      reasons: ['内容为空'],
      metrics: { proseChars, nonEmptyLines: nonEmptyLines.length },
    }
  }

  if (/^<!doctype html/i.test(lower) || /<html[\s>]/i.test(lower) || /<body[\s>]/i.test(lower)) {
    strongBadSignals.push('检测到 HTML 页面内容')
  }
  if (/^\s*[\[{]/.test(trimmed) && (countRegexMatches(trimmed, /[{}\[\]"]+/g) > proseChars / 2)) {
    strongBadSignals.push('检测到 JSON/结构化数据特征过强')
  }
  if (/^\s*co-authored-by:/im.test(trimmed) || /^##\s+test plan/im.test(trimmed) || /^##\s+summary/im.test(trimmed)) {
    strongBadSignals.push('检测到 PR/报告模板内容')
  }
  if (rolePrefixLines >= 3) {
    strongBadSignals.push('检测到聊天转录标记')
  }
  if (logPrefixLines >= 2 || /traceback \(most recent call last\):/i.test(trimmed)) {
    strongBadSignals.push('检测到日志/堆栈内容')
  }
  if (codeFenceCount >= 2) {
    warnSignals.push('代码块较多')
  }
  if (htmlTagCount >= 8) {
    warnSignals.push('HTML 标签较多')
  }
  if (keyValueLines >= 12 && proseChars < 400) {
    warnSignals.push('键值对结构较多，正文特征偏弱')
  }
  if (headingLines + bulletLines + numberedLines > Math.max(6, Math.floor(nonEmptyLines.length * 0.6))) {
    warnSignals.push('列表/标题型内容占比过高')
  }
  if (kind === 'chapter' && /^#\s+/.test(trimmed) && codeFenceCount >= 2 && proseChars < 250) {
    strongBadSignals.push('检测到说明文档/脚本说明特征过强')
  }

  if (kind === 'chapter') {
    if (strongBadSignals.length > 0) {
      return {
        level: 'block',
        reasons: strongBadSignals,
        metrics: { proseChars, nonEmptyLines: nonEmptyLines.length, rolePrefixLines, logPrefixLines, keyValueLines },
      }
    }
    if (warnSignals.length > 0) {
      return {
        level: 'warn',
        reasons: warnSignals,
        metrics: { proseChars, nonEmptyLines: nonEmptyLines.length, rolePrefixLines, logPrefixLines, keyValueLines },
      }
    }
    return {
      level: 'ok',
      reasons: [],
      metrics: { proseChars, nonEmptyLines: nonEmptyLines.length },
    }
  }

  if (strongBadSignals.length > 0) {
    return {
      level: 'block',
      reasons: strongBadSignals,
      metrics: { proseChars, nonEmptyLines: nonEmptyLines.length, rolePrefixLines, logPrefixLines, keyValueLines },
    }
  }
  if (warnSignals.length > 0) {
    return {
      level: 'warn',
      reasons: warnSignals,
      metrics: { proseChars, nonEmptyLines: nonEmptyLines.length, rolePrefixLines, logPrefixLines, keyValueLines },
    }
  }
  return {
    level: 'ok',
    reasons: [],
    metrics: { proseChars, nonEmptyLines: nonEmptyLines.length },
  }
}

module.exports = { normalizeText, validateUtf8Buffer, readUtf8TextChecked, analyzeNovelLikeContent }
