#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { chineseToNumber, numToChinese } = require('./chapter-log-parser')

const projectDir = process.argv[2] || '.'
const mapFile = process.argv[3]
if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory() || !mapFile || !fs.existsSync(mapFile)) {
  console.error('ERROR: 缺少参数或目录/文件不存在')
  process.exit(1)
}

const mapLines = fs.readFileSync(mapFile, 'utf8').split(/\r?\n/).filter(Boolean)
const pairs = []
for (const line of mapLines) {
  const m = line.match(/^第(\d+)章.*→.*第(\d+)章/)
  if (!m) continue
  const oldNum = Number(m[1])
  const newRaw = m[2]
  const newNum = Number(newRaw)
  if (oldNum !== newNum) pairs.push({ oldNum, newRaw, newNum })
}
if (!pairs.length) {
  console.error('ERROR: 重命名映射为空，无法更新引用')
  process.exit(2)
}

// ── 崩溃恢复：检测上次未完成的 .bak/.tmp 残留 ──────────
function recoverStaleBakFiles(dir, subdirs) {
  const allDirs = [dir]
  for (const sub of subdirs) {
    const d = path.join(dir, sub)
    if (fs.existsSync(d)) allDirs.push(d)
  }
  // 检查 commit intent 标志 — 决定前滚还是后滚
  const intentPath = path.join(dir, '.__commit_intent__.json')
  const hasIntent = fs.existsSync(intentPath)
  let recovered = false
  for (const d of allDirs) {
    for (const name of fs.readdirSync(d)) {
      if (!name.endsWith('.md.bak')) continue
      const bakPath = path.join(d, name)
      const origPath = bakPath.slice(0, -4) // remove .bak
      const tmpPath = origPath + '.tmp'
      if (hasIntent) {
        // 前滚：commit intent 存在，说明 step 1 已全部完成，应该继续 step 2
        if (fs.existsSync(tmpPath) && !fs.existsSync(origPath)) {
          fs.renameSync(tmpPath, origPath)
          try { fs.unlinkSync(bakPath) } catch (_) {}
          console.error(`崩溃恢复(前滚): ${name} → ${path.basename(origPath)}`)
          recovered = true
        } else if (fs.existsSync(origPath)) {
          // step 2 已完成此文件，清理 .bak
          try { fs.unlinkSync(bakPath) } catch (_) {}
          if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath) } catch (_) {}
          recovered = true
        }
      } else {
        // 后滚：无 commit intent，说明 step 1 未全部完成，应该回滚
        if (!fs.existsSync(origPath)) {
          fs.renameSync(bakPath, origPath)
          console.error(`崩溃恢复(后滚): ${name} → ${path.basename(origPath)}`)
          recovered = true
        } else {
          try { fs.unlinkSync(bakPath) } catch (_) {}
          recovered = true
        }
        if (fs.existsSync(tmpPath)) {
          try { fs.unlinkSync(tmpPath) } catch (_) {}
        }
      }
    }
  }
  if (hasIntent) {
    try { fs.unlinkSync(intentPath) } catch (_) {}
  }
  return recovered
}
recoverStaleBakFiles(projectDir, ['characters', 'outline'])

const targets = []
for (const rel of ['chapter-log.md', 'foreshadowing.md', 'timeline.md', 'relationships.md']) {
  const p = path.join(projectDir, rel)
  if (fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink()) targets.push(p)
}
for (const dir of ['characters', 'outline']) {
  const full = path.join(projectDir, dir)
  if (!fs.existsSync(full)) continue
  for (const name of fs.readdirSync(full)) {
    if (!name.endsWith('.md')) continue
    const p = path.join(full, name)
    if (fs.lstatSync(p).isSymbolicLink()) continue
    targets.push(p)
  }
}
if (!targets.length) {
  console.log(`无需更新：未找到元数据文件`)
  process.exit(0)
}

// Build a lookup map from oldNum → newNum for all pairs
const oldToNew = new Map()
for (const pair of pairs) {
  oldToNew.set(pair.oldNum, pair.newNum)
}

// Format newNum preserving the original zero-padding width
function formatNum(newNum, origStr) {
  const s = String(newNum)
  if (origStr.length > s.length) return s.padStart(origStr.length, '0')
  return s
}

// ── 书名号《》保护 ─────────────────────────────────────────
// 预处理：将《…》内容替换为占位符，防止内部的"第X章"被误替换
// 例如：《神魔录第一章》中的"第一章"不应被修改
const BOOK_PLACEHOLDER_PREFIX = '\x01BOOK_'
const BOOK_PLACEHOLDER_SUFFIX = '\x01'
let bookPlaceholderCounter = 0
const bookPlaceholderMap = new Map()

function protectBookTitles(content) {
  return content.replace(/《[^》]*》/g, (m) => {
    const key = `${BOOK_PLACEHOLDER_PREFIX}${bookPlaceholderCounter++}${BOOK_PLACEHOLDER_SUFFIX}`
    bookPlaceholderMap.set(key, m)
    return key
  })
}

function restoreBookTitles(content) {
  for (const [key, value] of bookPlaceholderMap) {
    content = content.split(key).join(value)
  }
  return content
}

// Replace range references like 第3-4章 / 第003-004章 across all content
// Uses placeholder to prevent cascade with subsequent structured replacement
const PLACEHOLDER_PREFIX = '\x00CHREF_'
const PLACEHOLDER_SUFFIX = '\x00'
let placeholderCounter = 0
const placeholderMap = new Map()

function emitPlaceholder(replacement) {
  const key = `${PLACEHOLDER_PREFIX}${placeholderCounter++}${PLACEHOLDER_SUFFIX}`
  placeholderMap.set(key, replacement)
  return key
}

function restorePlaceholders(content) {
  for (const [key, value] of placeholderMap) {
    content = content.split(key).join(value)
  }
  return content
}

function replaceRangeRefs(content) {
  let changed = false
  // Pattern 1: normal range 第X-Y章 / 第X到Y章 / 第X至Y章
  content = content.replace(/第(\d+)([-–~～到至])(\d+)章/g, (match, startStr, dash, endStr) => {
    const startNum = Number(startStr)
    const endNum = Number(endStr)
    const startMapped = oldToNew.has(startNum)
    const endMapped = oldToNew.has(endNum)
    if (!startMapped && !endMapped) return match
    changed = true
    const newStart = startMapped ? formatNum(oldToNew.get(startNum), startStr) : startStr
    const newEnd = endMapped ? formatNum(oldToNew.get(endNum), endStr) : endStr
    return emitPlaceholder(`第${newStart}${dash}${newEnd}章`)
  })
  // Pattern 2: Chinese numeral range 第三-五章, 第三到五章, 第十至十五章
  content = content.replace(/第([零一二两三四五六七八九十百千万]+)([-–~～到至])([零一二两三四五六七八九十百千万]+)章/g, (match, startStr, dash, endStr) => {
    const startNum = chineseToNumber(startStr)
    const endNum = chineseToNumber(endStr)
    if (isNaN(startNum) || isNaN(endNum)) return match
    const startMapped = oldToNew.has(startNum)
    const endMapped = oldToNew.has(endNum)
    if (!startMapped && !endMapped) return match
    changed = true
    const newStart = startMapped ? String(oldToNew.get(startNum)) : String(startNum)
    const newEnd = endMapped ? String(oldToNew.get(endNum)) : String(endNum)
    return emitPlaceholder(`第${newStart}${dash}${newEnd}章`)
  })
  // Pattern 3: orphan range after deletion — [已删除:原第X章]-第Y章
  content = content.replace(/(\[已删除:原第\d+章\])([-–])(第(0*)(\d+)章)/g, (match, delPart, dash, _whole, pad, numStr) => {
    const num = Number(numStr)
    if (oldToNew.has(num)) {
      changed = true
      return emitPlaceholder(`${delPart}${dash}第${formatNum(oldToNew.get(num), pad + numStr)}章`)
    }
    return match
  })
  // Pattern 4: reverse orphan — 第X章-[已删除:原第Y章]
  content = content.replace(/(第(0*)(\d+)章)([-–])(\[已删除:原第\d+章\])/g, (match, _whole, pad, numStr, dash, delPart) => {
    const num = Number(numStr)
    if (oldToNew.has(num)) {
      changed = true
      return emitPlaceholder(`第${formatNum(oldToNew.get(num), pad + numStr)}章${dash}${delPart}`)
    }
    return match
  })
  return { content, changed }
}
const DELETED_RANGE_PLACEHOLDER_PREFIX = '\x02DEL_RANGE_'
const DELETED_RANGE_PLACEHOLDER_SUFFIX = '\x02'
let deletedRangePlaceholderCounter = 0
const deletedRangePlaceholderMap = new Map()

function emitDeletedRangePlaceholder(payload) {
  const key = `${DELETED_RANGE_PLACEHOLDER_PREFIX}${deletedRangePlaceholderCounter++}${DELETED_RANGE_PLACEHOLDER_SUFFIX}`
  deletedRangePlaceholderMap.set(key, payload)
  return key
}

function restoreDeletedRangePlaceholders(content) {
  for (const [key, payload] of deletedRangePlaceholderMap) {
    if (payload.kind === 'left-deleted') {
      content = content.split(key).join(`原第${payload.deletedNum}章至第${payload.keptDisplay}章`)
    } else if (payload.kind === 'right-deleted') {
      content = content.split(key).join(`第${payload.keptDisplay}章至原第${payload.deletedNum}章`)
    } else if (payload.kind === 'both-deleted') {
      content = content.split(key).join(`原第${payload.startNum}章至原第${payload.endNum}章`)
    }
  }
  return content
}

function replaceDeletedRangeRefs(content) {
  let changed = false
  content = content.replace(/\[已删除:原第(\d+)章\]([-–~～到至])第(0*\d+)章/g, (match, deletedNum, dash, keptDisplay) => {
    changed = true
    return emitDeletedRangePlaceholder({ kind: 'left-deleted', deletedNum, dash, keptDisplay })
  })
  content = content.replace(/第(0*\d+)章([-–~～到至])\[已删除:原第(\d+)章\]/g, (match, keptDisplay, dash, deletedNum) => {
    changed = true
    return emitDeletedRangePlaceholder({ kind: 'right-deleted', deletedNum, dash, keptDisplay })
  })
  content = content.replace(/\[已删除:原第(\d+)章\]([-–~～到至])\[已删除:原第(\d+)章\]/g, (match, startNum, dash, endNum) => {
    changed = true
    return emitDeletedRangePlaceholder({ kind: 'both-deleted', startNum, dash, endNum })
  })
  return { content, changed }
}

function restoreDeletedRangePlaceholdersAfterStructured(content) {
  return restoreDeletedRangePlaceholders(content)
}



// Single-pass replacer: match any 第X章 in structured contexts and look up in map
// This prevents cascade: 第5章→第4章→第3章 when both 5→4 and 4→3 exist
function replaceAllStructured(content) {
  let changed = false
  // Helper: given a matched chapter ref, look up replacement preserving original padding
  function lookupReplace(chapterStr) {
    const m = chapterStr.match(/^第(.+)章$/)
    if (!m) return null
    const num = chineseToNumber(m[1])
    if (isNaN(num) || !oldToNew.has(num)) return null
    if (/^\d+$/.test(m[1])) {
      return `第${formatNum(oldToNew.get(num), m[1])}章`
    }
    return `第${numToChinese(oldToNew.get(num))}章`
  }
  // Generic chapter ref pattern (arabic or Chinese numerals)
  const chapterRefPattern = /第(?:0*\d+|[零一二两三四五六七八九十百千万]+)章/g

  // Pattern 1: table cells — replace 第X章 inside | ... |
  content = content.replace(/^(\|.+)$/gm, (line) => {
    const newLine = line.replace(chapterRefPattern, (m) => {
      const r = lookupReplace(m)
      if (r) { changed = true; return r }
      return m
    })
    return newLine
  })

  // Pattern 2: labeled fields — - **字段名**[:：]? 第X章...
  content = content.replace(/^(-\s*\*\*(?:埋设章节|揭示章节|变化章节|首次出现|关联章节|章节|计划揭示)\*\*(?:[:：])?\s*)(.+)$/gm, (match, prefix, rest) => {
    const newRest = rest.replace(chapterRefPattern, (m) => {
      const r = lookupReplace(m)
      if (r) { changed = true; return r }
      return m
    })
    return prefix + newRest
  })

  // Pattern 3: h3 headings — ### 第X章...
  content = content.replace(/^(###\s*)(第(?:0*\d+|[零一二两三四五六七八九十百千万]+)章)(.*)$/gm, (match, prefix, chap, rest) => {
    const r = lookupReplace(chap)
    if (r) { changed = true; return prefix + r + rest }
    return match
  })

  // Pattern 4: h2 headings — ## 第X章...
  content = content.replace(/^(##\s*)(第(?:0*\d+|[零一二两三四五六七八九十百千万]+)章)(.*)$/gm, (match, prefix, chap, rest) => {
    const r = lookupReplace(chap)
    if (r) { changed = true; return prefix + r + rest }
    return match
  })

  return { content, changed }
}

// Copy-on-write: compute all changes first, write to .tmp, then atomically rename
const pendingWrites = []
let changedFiles = 0
for (const file of targets) {
  let content = fs.readFileSync(file, 'utf8')
  let fileChanged = false
  // 保护书名号内容，防止《神魔录第一章》被误替换
  content = protectBookTitles(content)
  const deletedRangeOut = replaceDeletedRangeRefs(content)
  content = deletedRangeOut.content
  fileChanged ||= deletedRangeOut.changed
  const rangeOut = replaceRangeRefs(content)
  content = rangeOut.content
  fileChanged ||= rangeOut.changed
  content = restorePlaceholders(content)
  const structOut = replaceAllStructured(content)
  content = structOut.content
  fileChanged ||= structOut.changed
  content = restoreDeletedRangePlaceholdersAfterStructured(content)
  // 恢复书名号原始内容
  content = restoreBookTitles(content)
  if (fileChanged) {
    const tmpFile = file + '.tmp'
    fs.writeFileSync(tmpFile, content, 'utf8')
    pendingWrites.push({ tmpFile, file })
    changedFiles++
  }
}
// Atomic commit: .bak + rename 三阶段提交
const backedUp = []
const committed = []
let commitError = null
const commitIntentPath = path.join(projectDir, '.__commit_intent__.json')

try {
  // Step 1: 原文件全部重命名为 .bak（保护原文件 inode）
  for (const pw of pendingWrites) {
    const bakFile = pw.file + '.bak'
    fs.renameSync(pw.file, bakFile)
    backedUp.push({ file: pw.file, bak: bakFile, tmp: pw.tmpFile })
  }
  // Step 1.5: 写入 commit intent 标志（表示 step 1 全部完成，后续应前滚）
  fs.writeFileSync(commitIntentPath, JSON.stringify({ op: 'update-refs', ts: Date.now(), files: backedUp.map(b => b.file) }), 'utf8')
  // Step 2: 将 .tmp 重命名为正式文件（rename 是文件系统级原子操作）
  for (const item of backedUp) {
    fs.renameSync(item.tmp, item.file)
    committed.push(item)
  }
} catch (e) {
  commitError = e
}

if (commitError) {
  // 先销毁 commit intent，确保崩溃恢复时触发后滚而非前滚
  try { fs.unlinkSync(commitIntentPath) } catch (_) {}
  // 回滚：撤销已提交的 .tmp → file（rename 回 .tmp）
  for (const item of committed) {
    try { fs.renameSync(item.file, item.tmp) } catch (_) {}
  }
  // 恢复：将 .bak 重命名回正式文件
  const rolledBack = []
  for (const item of backedUp) {
    try { fs.renameSync(item.bak, item.file); rolledBack.push(path.basename(item.file)) }
    catch (re) { console.error(`  致命: 无法恢复 ${path.basename(item.file)} — ${re.message}`) }
  }
  // 清理残留 .tmp
  for (const pw of pendingWrites) {
    try { fs.unlinkSync(pw.tmpFile) } catch (_) {}
  }
  console.error(`ERROR: 提交失败: ${commitError.message}`)
  if (rolledBack.length) console.error(`  已回滚: ${rolledBack.join(', ')}`)
  process.exit(3)
}

// 事务成功，清理 .bak 和 commit intent
for (const item of backedUp) {
  try { fs.unlinkSync(item.bak) } catch (_) {}
}
try { fs.unlinkSync(commitIntentPath) } catch (_) {}
if (!changedFiles) {
  console.log(`无需更新：${pairs.length} 个编号变更均未命中结构化章节引用`)
} else {
  console.log(`全局结构化章节引用更新完毕，处理了 ${pairs.length} 个编号变更，实际更新 ${changedFiles} 个文件。`)
}
