#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { chineseToNumber } = require('./chapter-log-parser')

const projectDir = process.argv[2] || '.'
const deletedNumsFile = process.argv[3]
if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory() || !deletedNumsFile || !fs.existsSync(deletedNumsFile)) {
  console.error('ERROR: 缺少参数或目录/文件不存在')
  process.exit(1)
}

const deletedNums = fs.readFileSync(deletedNumsFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number)
if (!deletedNums.length) {
  console.error('ERROR: 未提供有效的已删章节编号')
  process.exit(2)
}

// ── 崩溃恢复：检测上次未完成的 .bak/.tmp 残留 ──────────
function recoverStaleBakFiles(dir, subdirs) {
  const allDirs = [dir]
  for (const sub of subdirs) {
    const d = path.join(dir, sub)
    if (fs.existsSync(d)) allDirs.push(d)
  }
  const intentPath = path.join(dir, '.__commit_intent__.json')
  const hasIntent = fs.existsSync(intentPath)
  let recovered = false
  for (const d of allDirs) {
    for (const name of fs.readdirSync(d)) {
      if (!name.endsWith('.md.bak')) continue
      const bakPath = path.join(d, name)
      const origPath = bakPath.slice(0, -4)
      const tmpPath = origPath + '.tmp'
      if (hasIntent) {
        if (fs.existsSync(tmpPath) && !fs.existsSync(origPath)) {
          fs.renameSync(tmpPath, origPath)
          try { fs.unlinkSync(bakPath) } catch (_) {}
          console.error(`崩溃恢复(前滚): ${name} → ${path.basename(origPath)}`)
          recovered = true
        } else if (fs.existsSync(origPath)) {
          try { fs.unlinkSync(bakPath) } catch (_) {}
          if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath) } catch (_) {}
          recovered = true
        }
      } else {
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
  console.log(`无需清理：未找到元数据文件`)
  process.exit(0)
}

const deletedSet = new Set(deletedNums)

// Generic chapter ref pattern (arabic or Chinese numerals)
const chapterRefPattern = /第(?:0*\d+|[零一二两三四五六七八九十百千万]+)章/g

// ── 书名号《》保护 ─────────────────────────────────────────
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

// Placeholder system to prevent range markers from being re-matched by structured pass
const PLACEHOLDER_PREFIX = '\x00DELREF_'
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

function markDeletedRangeRefs(content) {
  let changed = false
  // 阿拉伯数字区间: 第3-5章
  content = content.replace(/第(\d+)([-–])(\d+)章/g, (match, startStr, dash, endStr) => {
    const startNum = Number(startStr)
    const endNum = Number(endStr)
    const startDel = deletedSet.has(startNum)
    const endDel = deletedSet.has(endNum)
    if (!startDel && !endDel) return match
    changed = true
    const newStart = startDel ? `[已删除:原第${startStr}章]` : `第${startStr}章`
    const newEnd = endDel ? `[已删除:原第${endStr}章]` : `第${endStr}章`
    return emitPlaceholder(`${newStart}${dash}${newEnd}`)
  })
  // 中文数字区间: 第三-五章, 第七–九章, 第三到五章, 第十至十五章
  content = content.replace(/第([零一二两三四五六七八九十百千万]+)([-–~～到至])([零一二两三四五六七八九十百千万]+)章/g, (match, startStr, dash, endStr) => {
    const startNum = chineseToNumber(startStr)
    const endNum = chineseToNumber(endStr)
    if (isNaN(startNum) || isNaN(endNum)) return match
    const startDel = deletedSet.has(startNum)
    const endDel = deletedSet.has(endNum)
    if (!startDel && !endDel) return match
    changed = true
    const newStart = startDel ? `[已删除:原第${startNum}章]` : `第${startStr}章`
    const newEnd = endDel ? `[已删除:原第${endNum}章]` : `第${endStr}章`
    return emitPlaceholder(`${newStart}${dash}${newEnd}`)
  })
  return { content, changed }
}

// Single-pass structured deletion marker — replaces all chapter refs in structured contexts
function markDeletedStructured(content) {
  let changed = false

  function lookupMark(chapterStr) {
    const m = chapterStr.match(/^第(.+)章$/)
    if (!m) return null
    const num = chineseToNumber(m[1])
    if (isNaN(num)) return null
    if (deletedSet.has(num)) return `[已删除:原第${num}章]`
    return null
  }
  // Pattern 1: table cells — replace 第X章 inside | ... |
  content = content.replace(/^(\|.+)$/gm, (line) => {
    return line.replace(chapterRefPattern, (m) => {
      const r = lookupMark(m)
      if (r) { changed = true; return r }
      return m
    })
  })

  // Pattern 2: labeled fields — - **字段名**[:：]? 第X章...
  content = content.replace(/^(-\s*\*\*(?:埋设章节|揭示章节|变化章节|首次出现|关联章节|章节|计划揭示)\*\*(?:[:：])?\s*)(.+)$/gm, (match, prefix, rest) => {
    const newRest = rest.replace(chapterRefPattern, (m) => {
      const r = lookupMark(m)
      if (r) { changed = true; return r }
      return m
    })
    return prefix + newRest
  })

  // Pattern 3: h3 headings — ### 第X章...
  content = content.replace(/^(###\s*)(第(?:0*\d+|[零一二两三四五六七八九十百千万]+)章)(.*)$/gm, (match, prefix, chap, rest) => {
    const r = lookupMark(chap)
    if (r) { changed = true; return prefix + r + rest }
    return match
  })

  // Pattern 4: h2 headings — ## 第X章...
  content = content.replace(/^(##\s*)(第(?:0*\d+|[零一二两三四五六七八九十百千万]+)章)(.*)$/gm, (match, prefix, chap, rest) => {
    const r = lookupMark(chap)
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
  content = protectBookTitles(content)
  const rangeOut = markDeletedRangeRefs(content)
  content = rangeOut.content
  fileChanged ||= rangeOut.changed
  const structOut = markDeletedStructured(content)
  content = structOut.content
  fileChanged ||= structOut.changed
  content = restorePlaceholders(content)
  content = restoreBookTitles(content)
  if (fileChanged) {
    // 清理：删除仅包含已删除标记的孤立行和空段落
    // 例如 "- **埋设章节**: [已删除:原第3章]" → 整行移除
    content = content.replace(/^-\s*\*\*[^*]+\*\*(?:[:：])?\s*\[已删除:原第\d+章\]\s*$/gm, '')
    // 移除仅包含已删除标记的表格行（保留分隔行 |---|）
    content = content.replace(/^\|(?:\s*\[已删除:原第\d+章\]\s*\|)+\s*$/gm, '')
    // 移除仅包含已删除标记的标题（### [已删除:原第X章]...）
    content = content.replace(/^###\s*\[已删除:原第\d+章\].*$/gm, '')
    // 折叠多余空行
    content = content.replace(/\n{3,}/g, '\n\n')
    const tmpFile = file + '.tmp'
    fs.writeFileSync(tmpFile, content, 'utf8')
    pendingWrites.push({ tmpFile, file })
    changedFiles++
  }
}
// Atomic commit: .bak + commit intent + rename 三阶段提交
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
  fs.writeFileSync(commitIntentPath, JSON.stringify({ op: 'clean-deleted-refs', ts: Date.now(), files: backedUp.map(b => b.file) }), 'utf8')
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
  console.log(`无需清理：被删章节编号未命中任何结构化章节引用`)
} else {
  console.log(`已按结构化字段清理被删章节引用，实际更新 ${changedFiles} 个文件`)
}
