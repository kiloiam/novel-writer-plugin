#!/usr/bin/env node
/**
 * replace-paragraph.js — 三锚点结构化段落替换
 *
 * 用法：
 *   node replace-paragraph.js <章节文件> <新段落文件> [选项...]
 *
 * 选项：
 *   --before <文本>     前文锚点（目标段之前的文本，用于定位）
 *   --target <文本>     要替换的目标段落
 *   --after  <文本>     后文锚点（目标段之后的文本，用于定位）
 *
 * 三锚点规则：
 * - 必须提供 --before 和 --after 中至少一个，加上 --target
 * - 候选匹配数必须恰好为 1
 *   - 0 个：失败，要求重新定位
 *   - >1 个：失败，要求补更长锚点
 * - 替换前自动归档旧版本
 * - 替换后校验文件完整性
 *
 * 输出 JSON：
 *   { ok, file, archived, old_length, new_length, match_position }
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { normalizeText } = require('./text-utils')
const { acquireLock } = require('./project-lock')

// ── 参数解析 ──────────────────────────────────────────────
const chapterFile = process.argv[2]
const newContentFile = process.argv[3]

if (!chapterFile || !newContentFile) {
  console.error('用法: node replace-paragraph.js <章节文件> <新段落文件> [选项...]')
  process.exit(1)
}

if (!fs.existsSync(chapterFile)) { console.error(`ERROR: 章节文件不存在: ${chapterFile}`); process.exit(1) }
if (!fs.existsSync(newContentFile)) { console.error(`ERROR: 新段落文件不存在: ${newContentFile}`); process.exit(1) }

// symlink 检查
if (fs.lstatSync(chapterFile).isSymbolicLink()) { console.error('ERROR: 章节文件是符号链接，拒绝操作'); process.exit(1) }

// 路径安全检查：章节文件必须在 chapters/ 目录内且是合法章节文件名
const resolvedChapter = path.resolve(chapterFile)
const chapterBasename = path.basename(resolvedChapter)
if (!/^第\d+章(-.+)?\.md$/.test(chapterBasename)) {
  console.error(`ERROR: 不是合法章节文件名: ${chapterBasename}（期望格式: 第NNN章-标题.md）`)
  process.exit(1)
}
const parentDirName = path.basename(path.dirname(resolvedChapter))
if (parentDirName !== 'chapters') {
  console.error(`ERROR: 章节文件不在 chapters/ 目录内: ${resolvedChapter}`)
  process.exit(1)
}

const args = process.argv.slice(4)
const opts = { before: null, target: null, after: null }

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  const next = () => { if (i + 1 >= args.length) { console.error(`ERROR: ${arg} 需要一个值`); process.exit(1) }; return args[++i] }
  switch (arg) {
    case '--before': opts.before = next(); break
    case '--target': opts.target = next(); break
    case '--after': opts.after = next(); break
    default: console.error(`WARNING: 忽略未知选项 ${arg}`); break
  }
}

if (!opts.target) {
  console.error('ERROR: 必须提供 --target（要替换的目标段落）')
  process.exit(1)
}

if (!opts.before && !opts.after) {
  console.error('ERROR: 必须提供 --before 或 --after 中至少一个锚点')
  process.exit(1)
}

// ── 获取锁 ─────────────────────────────────────────────
const chaptersDir = path.dirname(chapterFile)
const projectDir = path.resolve(chaptersDir, '..')
let releaseLock = () => {}
try {
  releaseLock = acquireLock(projectDir, 'replace-paragraph')
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  process.exit(5)
}

const result = { ok: false, file: path.basename(chapterFile), archived: null, old_length: 0, new_length: 0, match_position: -1, warnings: [] }

try {
  const content = normalizeText(fs.readFileSync(chapterFile, 'utf8'))
  const newParagraph = normalizeText(fs.readFileSync(newContentFile, 'utf8'))
  const target = normalizeText(opts.target)
  const before = opts.before ? normalizeText(opts.before) : null
  const after = opts.after ? normalizeText(opts.after) : null

  result.old_length = content.length

  // ── 查找候选位置 ──────────────────────────────────────
  const candidates = []
  let searchFrom = 0

  while (true) {
    const targetIdx = content.indexOf(target, searchFrom)
    if (targetIdx === -1) break

    let valid = true

    // 验证前文锚点
    if (before) {
      const beforeRegion = content.slice(Math.max(0, targetIdx - before.length * 3), targetIdx)
      if (!beforeRegion.includes(before)) {
        valid = false
      }
    }

    // 验证后文锚点
    if (after) {
      const afterStart = targetIdx + target.length
      const afterRegion = content.slice(afterStart, Math.min(content.length, afterStart + after.length * 3))
      if (!afterRegion.includes(after)) {
        valid = false
      }
    }

    if (valid) {
      candidates.push(targetIdx)
    }

    searchFrom = targetIdx + 1
  }

  // ── 候选数检查 ────────────────────────────────────────
  if (candidates.length === 0) {
    result.error = '未找到匹配：目标段落与锚点组合在文件中无命中。请检查锚点文本是否准确'
    result.candidates = 0
    releaseLock()
    console.log(JSON.stringify(result, null, 2))
    process.exit(2)
  }

  if (candidates.length > 1) {
    result.error = `找到 ${candidates.length} 个匹配位置，必须恰好 1 个。请提供更长的锚点以缩小范围`
    result.candidates = candidates.length
    result.positions = candidates
    releaseLock()
    console.log(JSON.stringify(result, null, 2))
    process.exit(3)
  }

  // ── 恰好 1 个匹配 → 执行替换 ─────────────────────────
  const matchPos = candidates[0]
  result.match_position = matchPos

  // 归档旧版本
  const scriptDir = __dirname
  const childEnv = { ...process.env, NOVEL_WRITER_LOCK_HELD: path.resolve(projectDir) }
  try {
    const archiveResult = execFileSync(process.execPath, [
      path.join(scriptDir, 'archive.js'), chapterFile, 'rewrite-paragraph', chaptersDir
    ], { encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    result.archived = archiveResult
  } catch (_) {
    result.warnings.push('归档旧版本失败（非致命）')
  }

  // 执行替换
  // 不对新内容做 trim()，保留原始段落间空行结构
  // 如果强制 trim 会导致新段落与前后文粘连（丢失 \n\n 段落分隔）
  const newContent = content.slice(0, matchPos) + newParagraph + content.slice(matchPos + target.length)

  // ── 完整性校验 ────────────────────────────────────────
  // 1. 新旧长度差异检查（预警超过 50% 变化）
  const lengthRatio = newContent.length / content.length
  if (lengthRatio < 0.5 || lengthRatio > 2.0) {
    result.warnings.push(`长度变化较大 (${content.length} → ${newContent.length}，比率 ${lengthRatio.toFixed(2)})`)
  }

  // 2. 原子写入（.tmp + rename，防断电截断）
  const tmpWrite = chapterFile + '.tmp'
  fs.writeFileSync(tmpWrite, newContent, 'utf8')
  fs.renameSync(tmpWrite, chapterFile)
  result.new_length = newContent.length

  // 3. 验证写入成功
  const verify = fs.readFileSync(chapterFile, 'utf8')
  if (verify.length !== newContent.length) {
    result.warnings.push('写入后长度校验不一致')
  }

  result.ok = true
} catch (e) {
  result.error = e.message
} finally {
  releaseLock()
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(2)
