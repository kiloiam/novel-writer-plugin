#!/usr/bin/env node
/**
 * restore-chapter.js — 章节恢复事务
 *
 * 用法：
 *   node restore-chapter.js <项目目录> <归档文件路径> [选项...]
 *
 * 选项：
 *   --log-entry <文件>     日志条目文件（追加到 chapter-log.md）
 *   --mode <deleted|history>  恢复模式（默认自动检测）
 *     deleted: 从 _deleted/ 恢复（需要重编号）
 *     history: 从 _history/ 恢复（覆盖当前正文，不重编号）
 *   --target-chapter <编号>  history 模式下指定目标章节编号（必需）
 *
 * 事务保障：
 * - 操作日志 .__op_journal__.json 记录当前 phase
 * - 全部完成后自动清理日志与临时文件
 *
 * 输出 JSON：
 *   { ok, restored_file, chapter_num, renumbered, log_entry_source, warnings }
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { acquireLock } = require('./project-lock')
const { normalizeText } = require('./text-utils')

// ── 参数解析 ──────────────────────────────────────────────
const projectDir = process.argv[2]
const archiveFile = process.argv[3]

if (!projectDir || !archiveFile) {
  console.error('用法: node restore-chapter.js <项目目录> <归档文件路径> [选项...]')
  process.exit(1)
}

if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  console.error(`ERROR: 项目目录不存在: ${projectDir}`)
  process.exit(1)
}

if (!fs.existsSync(archiveFile)) {
  console.error(`ERROR: 归档文件不存在: ${archiveFile}`)
  process.exit(1)
}

const chaptersDir = path.join(projectDir, 'chapters')
if (!fs.existsSync(chaptersDir)) fs.mkdirSync(chaptersDir, { recursive: true })

const scriptDir = __dirname
const args = process.argv.slice(4)
const opts = {
  logEntry: null,
  mode: null,       // auto-detect
  targetChapter: 0, // for history mode
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  const next = () => { if (i + 1 >= args.length) { console.error(`ERROR: ${arg} 需要一个值`); process.exit(1) }; return args[++i] }
  switch (arg) {
    case '--log-entry': opts.logEntry = next(); break
    case '--mode': opts.mode = next(); break
    case '--target-chapter': opts.targetChapter = Number(next()); break
    default: console.error(`WARNING: 忽略未知选项 ${arg}`); break
  }
}

// Auto-detect mode from archive path
if (!opts.mode) {
  if (archiveFile.includes('_deleted')) {
    opts.mode = 'deleted'
  } else if (archiveFile.includes('_history')) {
    opts.mode = 'history'
  } else {
    // Try to detect from filename pattern
    if (/--deleted\.md$/.test(archiveFile)) {
      opts.mode = 'deleted'
    } else {
      opts.mode = 'history'
    }
  }
}

// ── 项目级互斥锁 ─────────────────────────────────────────
let releaseLock
try {
  releaseLock = acquireLock(projectDir, 'restore-chapter')
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  process.exit(5)
}

const childEnv = { ...process.env, NOVEL_WRITER_LOCK_HELD: path.resolve(projectDir) }

// ── 预飞检查：验证 PROJECT.yaml 可读写 ───────────────────
const yamlPreflightPath = path.join(projectDir, 'PROJECT.yaml')
if (fs.existsSync(yamlPreflightPath)) {
  try {
    const stat = fs.statSync(yamlPreflightPath)
    if (!stat.isFile()) {
      console.error(`ERROR: PROJECT.yaml 不是常规文件，拒绝操作以防部分提交`)
      releaseLock()
      process.exit(8)
    }
    fs.readFileSync(yamlPreflightPath, 'utf8')
    fs.accessSync(yamlPreflightPath, fs.constants.W_OK)
  } catch (e) {
    console.error(`ERROR: PROJECT.yaml 不可访问 (${e.code || e.message})，拒绝操作`)
    releaseLock()
    process.exit(8)
  }
}

const journalPath = path.join(chaptersDir, '.__op_journal__.json')
const result = { ok: false, restored_file: '', chapter_num: 0, renumbered: [], log_entry_source: null, warnings: [] }

function runFile(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

function runFileSafe(bin, args) {
  try {
    return { stdout: runFile(bin, args), code: 0 }
  } catch (e) {
    return { stdout: (e.stdout || '').trim(), stderr: (e.stderr || '').trim(), code: e.status || 1 }
  }
}

function writeJournal(phase, detail) {
  const content = JSON.stringify({
    op: 'restore', ts: new Date().toISOString(),
    targets: [path.basename(archiveFile)], phase, detail: detail || {},
  }, null, 2)
  const tmpPath = journalPath + '.tmp'
  fs.writeFileSync(tmpPath, content, 'utf8')
  fs.renameSync(tmpPath, journalPath)
}

function fail(phase, msg) {
  result.phase = phase
  result.error = msg
  result.journal_path = journalPath
  releaseLock()
  console.log(JSON.stringify(result, null, 2))
  process.exit(2)
}

// ── 中断恢复检查 ──────────────────────────────────────────
const forceClear = process.argv.includes('--force-clear')
if (fs.existsSync(journalPath)) {
  if (forceClear) {
    console.error('WARNING: --force-clear 强制清除残留操作日志')
    try { fs.unlinkSync(journalPath) } catch (_) {}
  } else {
    let phase = '未知', op = '未知'
    try {
      const existing = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
      phase = existing.phase || phase
      op = existing.op || op
    } catch (_) {
      // 日志文件损坏（空文件或非法 JSON）
    }
    console.error(`WARNING: 检测到未完成的操作日志 (phase: ${phase})`)
    fail('interrupted', `上次操作 (${op}) 未完成，phase=${phase}。可使用 --force-clear 强制清除`)
  }
}

// ── 从归档文件名提取原章节编号和标题 ───────────────────────
function extractChapterInfo(archivePath) {
  const basename = path.basename(archivePath, '.md')
  // 归档格式: 第005章-高潮--决战之巅--20260415-093012-123--deleted
  // 用 split('--') 剥离末尾两段（操作类型 + 时间戳），剩余 join('--') 即为原名
  const parts = basename.split('--')
  if (parts.length >= 3) {
    // 至少 3 段：原名部分 / 时间戳 / 操作类型
    const origName = parts.slice(0, -2).join('--')
    const m = origName.match(/^第(\d+)章(?:-(.+))?$/)
    if (m) {
      return { num: Number(m[1]), title: m[2] || '' }
    }
  }
  // fallback: 不带时间戳的格式（裸章节名）
  const m2 = basename.match(/^第(\d+)章(?:-(.+))?$/)
  if (m2) {
    return { num: Number(m2[1]), title: m2[2] || '' }
  }
  return { num: 0, title: '' }
}

// ── 查找现有章节文件 ──────────────────────────────────────
function findChapterFile(num) {
  for (const name of fs.readdirSync(chaptersDir)) {
    const fullPath = path.join(chaptersDir, name)
    try { if (fs.lstatSync(fullPath).isSymbolicLink()) continue } catch (_) { continue }
    const m = name.match(/^第(\d+)章(-.+)?\.md$/)
    if (m && Number(m[1]) === num) return name
  }
  return null
}

// ── 查找侧车日志条目 ──────────────────────────────────────
function findSidecarLogEntry(archivePath) {
  const basename = path.basename(archivePath, '.md')
  // 从归档文件名推导侧车文件名: 第005章-xxx--20260415-093012-123--log-entry.md
  // 兼容旧格式（无毫秒）: 第005章-xxx--20260415-093012--log-entry.md
  const m = basename.match(/^(.+)--(\d{8}-\d{6}(?:-\d{3})?)--(.+)$/)
  if (m) {
    const sidecarName = `${m[1]}--${m[2]}--log-entry.md`
    const sidecarPath = path.join(path.dirname(archivePath), sidecarName)
    if (fs.existsSync(sidecarPath)) return sidecarPath
  }
  return null
}

// ══════════════════════════════════════════════════════════
// MODE: history — 从 _history/ 恢复（覆盖当前正文）
// ══════════════════════════════════════════════════════════
if (opts.mode === 'history') {
  if (!opts.targetChapter) {
    // 尝试从归档文件名提取
    const info = extractChapterInfo(archiveFile)
    if (info.num > 0) {
      opts.targetChapter = info.num
    } else {
      fail('init', 'history 模式需要 --target-chapter 或可解析的归档文件名')
    }
  }

  const targetFile = findChapterFile(opts.targetChapter)
  if (!targetFile) {
    fail('init', `第${opts.targetChapter}章不存在，无法恢复（如果章节已删除，请使用 --mode deleted）`)
  }

  const targetPath = path.join(chaptersDir, targetFile)

  // Phase: pre-copy
  writeJournal('pre-copy', { target: targetFile, archive: path.basename(archiveFile) })

  // 归档当前正文
  const archiveResult = runFileSafe(process.execPath, [
    path.join(scriptDir, 'archive.js'), targetPath, 'restore', chaptersDir
  ])
  if (archiveResult.code !== 0) {
    fail('pre-copy', `归档当前正文失败: ${archiveResult.stderr}`)
  }

  // Phase: copied — 用归档内容覆盖当前文件
  // 写入前检查目标路径是否为 symlink，防止写穿项目边界
  if (fs.lstatSync(targetPath).isSymbolicLink()) {
    fs.unlinkSync(targetPath)
    result.warnings.push(`${targetFile} 是符号链接，已删除并替换为普通文件`)
  }
  const archiveContent = normalizeText(fs.readFileSync(archiveFile, 'utf8'))
  fs.writeFileSync(targetPath, archiveContent, 'utf8')

  // 恢复原标题：从归档文件名提取原标题，如果和当前文件名不一致则重命名
  const archiveInfo = extractChapterInfo(archiveFile)
  if (archiveInfo.title) {
    const width = Math.max(3, String(opts.targetChapter).length)
    const padded = String(opts.targetChapter).padStart(width, '0')
    const restoredName = `第${padded}章-${archiveInfo.title}.md`
    const restoredPath = path.join(chaptersDir, restoredName)
    if (restoredPath !== targetPath) {
      fs.renameSync(targetPath, restoredPath)
      result.restored_file = restoredName
    } else {
      result.restored_file = targetFile
    }
  } else {
    result.restored_file = targetFile
  }

  writeJournal('copied', { restoredTo: result.restored_file || targetFile })
  result.chapter_num = opts.targetChapter

  // 追加日志条目（如提供）
  if (opts.logEntry && fs.existsSync(opts.logEntry)) {
    const logContent = fs.readFileSync(opts.logEntry, 'utf8')
    const logFile = path.join(projectDir, 'chapter-log.md')
    const logIsSymlink = fs.existsSync(logFile) && fs.lstatSync(logFile).isSymbolicLink()
    if (logIsSymlink) {
      result.warnings.push('chapter-log.md 是符号链接，已跳过写入')
    } else if (fs.existsSync(logFile)) {
      let existing = fs.readFileSync(logFile, 'utf8').trimEnd()
      fs.writeFileSync(logFile, existing + '\n\n' + logContent.trim() + '\n', 'utf8')
    } else {
      fs.writeFileSync(logFile, '# 章节日志\n\n' + logContent.trim() + '\n', 'utf8')
    }
    result.log_entry_source = 'provided'
  }

  // 更新 PROJECT.yaml
  const updateArgs = [
    path.join(scriptDir, 'update-project.js'), projectDir,
    '--chapter', String(opts.targetChapter),
    '--last-action', JSON.stringify({
      type: 'restore', target: `第${opts.targetChapter}章`,
      timestamp: new Date().toISOString(),
    }),
  ]
  const updateResult = runFileSafe(process.execPath, updateArgs)
  if (updateResult.code !== 0) {
    result.warnings.push(`PROJECT.yaml 更新失败 (非致命): ${updateResult.stderr}`)
  }

  // 清理
  try { fs.unlinkSync(journalPath) } catch (_) {}
  releaseLock()
  result.ok = true
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

// ══════════════════════════════════════════════════════════
// MODE: deleted — 从 _deleted/ 恢复（需要重编号）
// ══════════════════════════════════════════════════════════
const chapterInfo = extractChapterInfo(archiveFile)
if (chapterInfo.num <= 0) {
  fail('init', `无法从归档文件名提取章节编号: ${path.basename(archiveFile)}`)
}

const origNum = chapterInfo.num
const origTitle = chapterInfo.title || '无题'

// Phase: pre-copy — 写入日志
writeJournal('pre-copy', { archive: path.basename(archiveFile), origNum, origTitle })

// 用安全暂存名放入 chapters/
const restoreSlotName = `.__restore__第${String(origNum).padStart(3, '0')}章-${origTitle}.md`
const restoreSlotPath = path.join(chaptersDir, restoreSlotName)

// 写入前拒绝 symlink，防止写穿项目边界
if (fs.existsSync(restoreSlotPath) && fs.lstatSync(restoreSlotPath).isSymbolicLink()) {
  fs.unlinkSync(restoreSlotPath)
  result.warnings.push(`${restoreSlotName} 是符号链接，已删除并替换为普通文件`)
}

const archiveContent = fs.readFileSync(archiveFile, 'utf8').replace(/\r\n/g, '\n')
fs.writeFileSync(restoreSlotPath, archiveContent, 'utf8')

writeJournal('copied', { restoreSlot: restoreSlotName })

// 检查并复用侧车日志条目
const sidecarPath = findSidecarLogEntry(archiveFile)
if (sidecarPath) {
  result.log_entry_source = 'sidecar'
}

// Phase: renumbered — 重编号（必须在追加日志之前，防止新日志条目被重编号污染）
const logFile = path.join(projectDir, 'chapter-log.md')
const logIsSymlink = fs.existsSync(logFile) && fs.lstatSync(logFile).isSymbolicLink()
const renumberResult = runFileSafe(process.execPath, [path.join(scriptDir, 'renumber.js'), chaptersDir])
if (renumberResult.code !== 0) {
  fail('copied', `重编号失败: ${renumberResult.stderr}`)
}

// 更新全局引用
if (renumberResult.stdout && renumberResult.stdout.includes('→')) {
  const renameLog = path.join(chaptersDir, `.tmp-rename-log-${Date.now()}.txt`)
  fs.writeFileSync(renameLog, renumberResult.stdout, 'utf8')

  const updateRefsResult = runFileSafe(process.execPath, [
    path.join(scriptDir, 'update-refs.js'), projectDir, renameLog
  ])
  if (updateRefsResult.code !== 0) {
    result.warnings.push(`全局引用更新失败 (非致命): ${updateRefsResult.stderr}`)
  }
  if (updateRefsResult.stdout) result.warnings.push(updateRefsResult.stdout)

  for (const line of renumberResult.stdout.split('\n')) {
    if (line.includes('→')) result.renumbered.push(line.trim())
  }

  try { fs.unlinkSync(renameLog) } catch (_) {}
}

writeJournal('renumbered')

// 排序日志
if (fs.existsSync(logFile)) {
  runFileSafe(process.execPath, [path.join(scriptDir, 'sort-log.js'), logFile])
}

// 追加日志条目（在重编号和排序之后，防止新条目被重编号逻辑污染）
if (logIsSymlink) {
  result.warnings.push('chapter-log.md 是符号链接，已跳过写入')
} else if (opts.logEntry && fs.existsSync(opts.logEntry)) {
  const logContent = fs.readFileSync(opts.logEntry, 'utf8')
  if (fs.existsSync(logFile)) {
    let existing = fs.readFileSync(logFile, 'utf8').trimEnd()
    fs.writeFileSync(logFile, existing + '\n\n' + logContent.trim() + '\n', 'utf8')
  } else {
    fs.writeFileSync(logFile, '# 章节日志\n\n' + logContent.trim() + '\n', 'utf8')
  }
  result.log_entry_source = 'provided'
} else if (sidecarPath) {
  const logContent = fs.readFileSync(sidecarPath, 'utf8')
  if (fs.existsSync(logFile)) {
    let existing = fs.readFileSync(logFile, 'utf8').trimEnd()
    fs.writeFileSync(logFile, existing + '\n\n' + logContent.trim() + '\n', 'utf8')
  } else {
    fs.writeFileSync(logFile, '# 章节日志\n\n' + logContent.trim() + '\n', 'utf8')
  }
  result.log_entry_source = 'sidecar'
}

// 追加后再次排序日志，确保顺序正确
if (fs.existsSync(logFile) && (opts.logEntry || sidecarPath)) {
  runFileSafe(process.execPath, [path.join(scriptDir, 'sort-log.js'), logFile])
}

// 确定恢复后的实际章节编号（通过 renumber 映射跟踪 restore slot）
let restoredNum = origNum
if (renumberResult.stdout) {
  for (const line of renumberResult.stdout.split('\n')) {
    if (!line.includes('→')) continue
    const [oldPart, newPart] = line.split('→').map(s => s.trim())
    if (oldPart === restoreSlotName) {
      const newMatch = newPart.match(/^第(\d+)章/)
      if (newMatch) {
        restoredNum = Number(newMatch[1])
        result.restored_file = newPart
      }
      break
    }
  }
}
if (!result.restored_file) {
  // fallback: 按原编号查找
  const f = findChapterFile(origNum)
  if (f) {
    result.restored_file = f
    restoredNum = origNum
  }
}
result.chapter_num = restoredNum

// ── 恢复已删除标记 ──────────────────────────────────────
// 删除章节时，元数据中的引用会被标记为 [已删除:原第N章]
// 恢复时需要把匹配原章节编号的标记还原为正常引用
function restoreDeletedMarkers(dir, origChapterNum, newChapterNum) {
  const metaFiles = []
  for (const rel of ['chapter-log.md', 'foreshadowing.md', 'timeline.md', 'relationships.md']) {
    const p = path.join(dir, rel)
    if (fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink()) metaFiles.push(p)
  }
  for (const sub of ['characters', 'outline']) {
    const subDir = path.join(dir, sub)
    if (!fs.existsSync(subDir)) continue
    for (const name of fs.readdirSync(subDir)) {
      if (!name.endsWith('.md')) continue
      const p = path.join(subDir, name)
      if (fs.lstatSync(p).isSymbolicLink()) continue
      metaFiles.push(p)
    }
  }
  const pattern = new RegExp(`\\[已删除:原第${origChapterNum}章\\]`, 'g')
  const width = Math.max(3, String(newChapterNum).length)
  const padded = String(newChapterNum).padStart(width, '0')
  const replacement = `第${padded}章`
  let restoredCount = 0
  for (const file of metaFiles) {
    const content = fs.readFileSync(file, 'utf8')
    const updated = content.replace(pattern, replacement)
    if (updated !== content) {
      fs.writeFileSync(file, updated, 'utf8')
      restoredCount++
    }
  }
  return restoredCount
}

const restoredMarkersCount = restoreDeletedMarkers(projectDir, origNum, restoredNum)
if (restoredMarkersCount > 0) {
  result.warnings.push(`已将 ${restoredMarkersCount} 个文件中的 [已删除:原第${origNum}章] 标记恢复为 第${restoredNum}章`)
}

// 更新 PROJECT.yaml（恢复操作：指针设为恢复目标章节）
const updateArgs = [
  path.join(scriptDir, 'update-project.js'), projectDir,
  '--chapter', String(restoredNum),
  '--last-action', JSON.stringify({
    type: 'restore', target: `第${restoredNum}章`,
    timestamp: new Date().toISOString(),
  }),
]

const updateResult = runFileSafe(process.execPath, updateArgs)
if (updateResult.code !== 0) {
  result.warnings.push(`PROJECT.yaml 更新失败 (非致命): ${updateResult.stderr}`)
}

// ── 完成 ─────────────────────────────────────────────────
try { fs.unlinkSync(journalPath) } catch (_) {}
releaseLock()
result.ok = true
console.log(JSON.stringify(result, null, 2))
