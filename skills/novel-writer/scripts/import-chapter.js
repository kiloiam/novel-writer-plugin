#!/usr/bin/env node
/**
 * import-chapter.js — 章节导入事务
 *
 * 用法：
 *   node import-chapter.js <项目目录> <模式> <章节文件1> [章节文件2 ...] [选项...]
 *
 * 模式：
 *   append   — 追加到末尾
 *   insert   — 插入到指定位置（需 --at <编号>）
 *   replace  — 替换已有章节（需 --at <编号>）
 *
 * 选项：
 *   --at <编号>            插入/替换起始编号
 *   --titles <t1,t2,...>   各章标题（逗号分隔，与章节文件一一对应；会自动净化）
 *   --log-entry <文件>     日志条目文件（追加到 chapter-log.md；多章时用分隔符 ## 分块）
 *   --characters <A,B,C>   导入章节的活跃角色（合并到 active_characters）
 *
 * 章节文件：每个文件是一个已经预处理好的纯文本 .md 文件（编码 UTF-8、格式已清理）。
 * 文件名不要求特定格式——脚本根据 --titles 和编号自动命名。
 *
 * 事务保障：
 * - 操作日志 .__op_journal__.json 记录当前 phase
 * - replace 模式先归档再覆盖
 * - insert 模式先写入再重编号
 * - 全部完成后自动清理日志
 *
 * 输出 JSON：
 *   { ok, imported: [{ file, chars }], renumbered, warnings }
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { acquireLock, buildInheritedLockEnvFromProject, buildUniqueTempPath } = require('./project-lock')
const { normalizeText, analyzeNovelLikeContent, readUtf8TextChecked } = require('./text-utils')

// ── 参数解析 ──────────────────────────────────────────────
const projectDir = process.argv[2]
const mode = process.argv[3]

if (!projectDir || !mode) {
  console.error('用法: node import-chapter.js <项目目录> <append|insert|replace> <章节文件...> [选项...]')
  process.exit(1)
}

if (!['append', 'insert', 'replace'].includes(mode)) {
  console.error(`ERROR: 无效模式: ${mode}（允许值: append, insert, replace）`)
  process.exit(1)
}

if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  console.error(`ERROR: 项目目录不存在: ${projectDir}`)
  process.exit(1)
}

const chaptersDir = path.join(projectDir, 'chapters')
if (!fs.existsSync(chaptersDir)) fs.mkdirSync(chaptersDir, { recursive: true })

const scriptDir = __dirname

// 分离文件参数和选项
const contentFiles = []
const opts = {
  at: 0,
  titles: [],
  logEntry: null,
  characters: [],
}

const rawArgs = process.argv.slice(4)
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i]
  const next = () => { if (i + 1 >= rawArgs.length) { console.error(`ERROR: ${arg} 需要一个值`); process.exit(1) }; return rawArgs[++i] }
  if (arg.startsWith('--')) {
    switch (arg) {
      case '--at': opts.at = Number(next()); break
      case '--titles': opts.titles = next().split(',').map(s => s.trim()); break
      case '--log-entry': opts.logEntry = next(); break
      case '--characters': opts.characters = next().split(',').map(s => s.trim()).filter(Boolean); break
      default: console.error(`WARNING: 忽略未知选项 ${arg}`); break
    }
  } else {
    contentFiles.push(arg)
  }
}

if (!contentFiles.length) {
  console.error('ERROR: 未提供章节文件')
  process.exit(1)
}

if (opts.logEntry) {
  const resolvedLogEntry = path.resolve(opts.logEntry)
  const resolvedProjectDir = path.resolve(projectDir)
  if (!resolvedLogEntry.startsWith(resolvedProjectDir + path.sep) && resolvedLogEntry !== path.join(resolvedProjectDir, path.basename(resolvedLogEntry))) {
    console.error(`ERROR: --log-entry 路径越界: ${opts.logEntry}`)
    process.exit(1)
  }
  opts.logEntry = resolvedLogEntry
}

// 验证所有内容文件存在，检测编码并容错处理
const fileEncodings = new Map() // f → 'utf8' | 'latin1'
const contentAnalyses = new Map()
const contentWarnings = []
for (const f of contentFiles) {
  if (!fs.existsSync(f)) {
    console.error(`ERROR: 章节文件不存在: ${f}`)
    process.exit(1)
  }

  let normalizedContent
  try {
    normalizedContent = readUtf8TextChecked(f)
    fileEncodings.set(f, 'utf8')
  } catch (e) {
    if (e.code === 'INVALID_UTF8') {
      console.error(`ERROR: ${e.message}`)
      console.error('请先将文件转换为 UTF-8 编码后重试（可使用 iconv 或编辑器另存为 UTF-8）')
      process.exit(1)
    }
    throw e
  }

  const analysis = analyzeNovelLikeContent(normalizedContent, { kind: 'chapter' })
  contentAnalyses.set(f, analysis)
  if (analysis.level === 'warn') {
    contentWarnings.push(`${path.basename(f)} 内容可疑，请人工确认：${analysis.reasons.join('；')}`)
  }
  if (analysis.level === 'block') {
    console.error(`ERROR: 内容保护已阻止导入 ${path.basename(f)}：${analysis.reasons.join('；')}`)
    process.exit(1)
  }
}

if ((mode === 'insert' || mode === 'replace') && (opts.at < 0 || isNaN(opts.at) || !Number.isInteger(opts.at))) {
  console.error(`ERROR: ${mode} 模式需要 --at <整数编号>（≥0）`)
  process.exit(1)
}

// ── 项目级互斥锁 ─────────────────────────────────────────
let releaseLock
try {
  releaseLock = acquireLock(projectDir, 'import-chapter')
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  process.exit(5)
}

const childEnv = buildInheritedLockEnvFromProject(projectDir, process.env)

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
const result = { ok: false, imported: [], renumbered: [], warnings: [...contentWarnings] }

function runFileSafe(bin, args) {
  try {
    return { stdout: execFileSync(bin, args, { encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }).trim(), code: 0 }
  } catch (e) {
    return { stdout: (e.stdout || '').trim(), stderr: (e.stderr || '').trim(), code: e.status || 1 }
  }
}

function writeJournal(phase, detail) {
  const content = JSON.stringify({
    op: mode === 'replace' ? 'import-replace' : mode === 'insert' ? 'import-insert' : 'import-append',
    ts: new Date().toISOString(),
    targets: contentFiles.map(f => path.basename(f)),
    phase, detail: detail || {},
  }, null, 2)
  const tmpPath = buildUniqueTempPath(journalPath)
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

// ── 中文数字 → 阿拉伯数字（使用共享解析器）──────────────
const { chineseToNumber, CHAPTER_HEADING_RE, ANY_HEADING_RE } = require('./chapter-log-parser')

// ── 工具函数 ──────────────────────────────────────────────
// 追加日志条目时，先移除同章旧条目（防止 replace/覆盖 导致重复）
function appendLogWithDedup(logFilePath, newLogContent, chapterNums) {
  // 拒绝 symlink，防止写穿项目边界
  if (fs.existsSync(logFilePath) && fs.lstatSync(logFilePath).isSymbolicLink()) return
  if (!fs.existsSync(logFilePath)) {
    if (!newLogContent.trim()) return
    fs.writeFileSync(logFilePath, '# 章节日志\n\n' + newLogContent.trim() + '\n', 'utf8')
    return
  }
  let existing = fs.readFileSync(logFilePath, 'utf8')
  if (chapterNums && chapterNums.length) {
    const lines = existing.split('\n')
    const filtered = []
    let skip = false
    const numsSet = new Set(chapterNums)
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CHAPTER_HEADING_RE)
      if (m) {
        skip = numsSet.has(chineseToNumber(m[1]))
        if (skip) continue
      } else if (skip && ANY_HEADING_RE.test(lines[i])) {
        skip = false
      }
      if (!skip) filtered.push(lines[i])
    }
    existing = filtered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  } else {
    existing = existing.trimEnd()
  }
  const trimmed = newLogContent.trim()
  if (trimmed) {
    fs.writeFileSync(logFilePath, existing + '\n\n' + trimmed + '\n', 'utf8')
  } else {
    fs.writeFileSync(logFilePath, existing + '\n', 'utf8')
  }
}
function sanitizeTitle(title) {
  if (!title) return '无题'
  // 内联净化（与 save-chapter.js 完全一致，不再依赖 bash fallback）
  let safe = title
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/\.+$/, '')                 // 末尾的点（Windows 不允许）
    .slice(0, 60)
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\..*)?$/i.test(safe)) safe = '_' + safe
  return safe || '无题'
}

function countChars(text) {
  const clean = text
    .replace(/^#.*$/gm, '')                      // headers
    .replace(/^---$/gm, '')                       // horizontal rules
    .replace(/^>/gm, '')                          // blockquotes
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')         // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')      // links → text
    .replace(/<[^>]+>/g, '')                       // HTML tags
    .replace(/`{1,3}[^`]*`{1,3}/g, '')            // inline code
    .replace(/\*\*/g, '')                          // bold
    .replace(/[*_~]/g, '')                         // italic/strikethrough
  return clean.replace(/\s/g, '').length
}

function findChapterFile(num) {
  for (const name of fs.readdirSync(chaptersDir)) {
    const fullPath = path.join(chaptersDir, name)
    try { if (fs.lstatSync(fullPath).isSymbolicLink()) continue } catch (_) { continue }
    const m = name.match(/^第(\d+)章(-.+)?\.md$/)
    if (m && Number(m[1]) === num) return fullPath
  }
  return null
}

function getMaxChapterNum() {
  let max = 0
  for (const name of fs.readdirSync(chaptersDir)) {
    const m = name.match(/^第(\d+)章(-.+)?\.md$/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

// ── 记录导入前的写作指针 ──────────────────────────────────
let origCurrentChapter = 0
let origCurrentFile = null
if (fs.existsSync(yamlPreflightPath)) {
  const m = fs.readFileSync(yamlPreflightPath, 'utf8').match(/^current_chapter:\s*(\d+)/m)
  if (m) {
    origCurrentChapter = Number(m[1])
    // 记录文件名以便重编号后跟踪
    const f = findChapterFile(origCurrentChapter)
    if (f) origCurrentFile = path.basename(f)
  }
}

// ══════════════════════════════════════════════════════════
// APPEND 模式
// ══════════════════════════════════════════════════════════
if (mode === 'append') {
  writeJournal('pre-write', { count: contentFiles.length })

  let startNum = getMaxChapterNum() + 1
  const imported = []

  for (let i = 0; i < contentFiles.length; i++) {
    const content = normalizeText(fs.readFileSync(contentFiles[i], fileEncodings.get(contentFiles[i]) || 'utf8'))
    const title = sanitizeTitle(opts.titles[i] || '')
    const num = startNum + i
    const width = Math.max(3, String(num).length)
    const padded = String(num).padStart(width, '0')
    const fileName = `第${padded}章-${title}.md`
    const targetPath = path.join(chaptersDir, fileName)

    fs.writeFileSync(targetPath, content, 'utf8')
    imported.push({ file: fileName, chars: countChars(content), num })
  }

  result.imported = imported
  writeJournal('written', { files: imported.map(i => i.file) })

  // 追加日志条目
  if (opts.logEntry && fs.existsSync(opts.logEntry)) {
    const logContent = fs.readFileSync(opts.logEntry, 'utf8')
    const logFile = path.join(projectDir, 'chapter-log.md')
    if (fs.existsSync(logFile) && fs.lstatSync(logFile).isSymbolicLink()) {
      result.warnings.push('chapter-log.md 是符号链接，已跳过写入')
    } else if (fs.existsSync(logFile)) {
      let existing = fs.readFileSync(logFile, 'utf8').trimEnd()
      fs.writeFileSync(logFile, existing + '\n\n' + logContent.trim() + '\n', 'utf8')
    } else {
      fs.writeFileSync(logFile, '# 章节日志\n\n' + logContent.trim() + '\n', 'utf8')
    }
  }

  // 排序日志
  const logFile = path.join(projectDir, 'chapter-log.md')
  if (fs.existsSync(logFile)) {
    runFileSafe(process.execPath, [path.join(scriptDir, 'sort-log.js'), logFile])
  }

  // 更新 PROJECT.yaml（追加模式默认将焦点移动到最后导入章节）
  const lastImportedChapter = imported.length ? Math.max(...imported.map(i => i.num)) : origCurrentChapter
  const updateArgs = [
    path.join(scriptDir, 'update-project.js'), projectDir,
    '--chapter', String(lastImportedChapter),
    '--last-action', JSON.stringify({
      type: 'import',
      targets: imported.map(i => `第${i.num}章`),
      timestamp: new Date().toISOString(),
    }),
  ]
  for (const c of opts.characters) updateArgs.push('--add-character', c)

  const updateResult = runFileSafe(process.execPath, updateArgs)
  if (updateResult.code !== 0) {
    result.warnings.push('导入正文已完成，但项目进度未完全同步。建议先查看状态或执行一次一致性巡检。')
  }

  try { fs.unlinkSync(journalPath) } catch (_) {}
  releaseLock()
  result.ok = true
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

// ══════════════════════════════════════════════════════════
// REPLACE 模式
// ══════════════════════════════════════════════════════════
if (mode === 'replace') {
  writeJournal('pre-archive', { at: opts.at, count: contentFiles.length })

  const archived = []

  // 归档所有会被覆盖的现有章节
  for (let i = 0; i < contentFiles.length; i++) {
    const targetNum = opts.at + i
    const existingFile = findChapterFile(targetNum)
    if (existingFile) {
      const r = runFileSafe(process.execPath, [
        path.join(scriptDir, 'archive.js'), existingFile, 'replace', chaptersDir
      ])
      if (r.code !== 0) {
        fail('pre-archive', `归档第${targetNum}章失败: ${r.stderr}`)
      }
      archived.push({ num: targetNum, archivePath: r.stdout })
    }
  }

  writeJournal('archived', { archived: archived.map(a => a.num) })

  // 写入新章节
  const imported = []
  for (let i = 0; i < contentFiles.length; i++) {
    const content = normalizeText(fs.readFileSync(contentFiles[i], fileEncodings.get(contentFiles[i]) || 'utf8'))
    const title = sanitizeTitle(opts.titles[i] || '')
    const num = opts.at + i
    const width = Math.max(3, String(num).length)
    const padded = String(num).padStart(width, '0')
    const fileName = `第${padded}章-${title}.md`
    const targetPath = path.join(chaptersDir, fileName)

    // 删除旧文件（如果标题不同导致文件名不同）
    const existingFile = findChapterFile(num)
    if (existingFile && existingFile !== targetPath) {
      try { fs.unlinkSync(existingFile) } catch (_) {}
    }

    // 写入前拒绝 symlink，防止写穿项目边界
    if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) {
      fs.unlinkSync(targetPath)
      result.warnings.push(`${fileName} 是符号链接，已删除并替换为普通文件`)
    }

    fs.writeFileSync(targetPath, content, 'utf8')
    imported.push({ file: fileName, chars: countChars(content), num })
  }

  result.imported = imported
  writeJournal('replaced', { files: imported.map(i => i.file) })

  // 追加日志条目（replace 模式先去重被替换章的旧条目）
  const logFile = path.join(projectDir, 'chapter-log.md')
  const replacedNums = imported.map(i => i.num)
  if (opts.logEntry && fs.existsSync(opts.logEntry)) {
    const logContent = fs.readFileSync(opts.logEntry, 'utf8')
    appendLogWithDedup(logFile, logContent, replacedNums)
  } else if (fs.existsSync(logFile)) {
    // 没有新日志条目时，仍需移除被替换章节的旧条目防止失真
    appendLogWithDedup(logFile, '', replacedNums)
  }

  // 排序日志
  if (fs.existsSync(logFile)) {
    runFileSafe(process.execPath, [path.join(scriptDir, 'sort-log.js'), logFile])
  }

  // 更新 PROJECT.yaml（替换模式不改 current_chapter）
  const updateArgs = [
    path.join(scriptDir, 'update-project.js'), projectDir,
    '--chapter', String(origCurrentChapter),
    '--last-action', JSON.stringify({
      type: 'import',
      targets: imported.map(i => `第${i.num}章`),
      timestamp: new Date().toISOString(),
    }),
  ]
  for (const c of opts.characters) updateArgs.push('--add-character', c)

  const updateResult = runFileSafe(process.execPath, updateArgs)
  if (updateResult.code !== 0) {
    result.warnings.push('导入正文已完成，但项目进度未完全同步。建议先查看状态或执行一次一致性巡检。')
  }

  try { fs.unlinkSync(journalPath) } catch (_) {}
  releaseLock()
  result.ok = true
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

// ══════════════════════════════════════════════════════════
// INSERT 模式
// ══════════════════════════════════════════════════════════
writeJournal('pre-write', { at: opts.at, count: contentFiles.length })

// 使用 .__restore__ 前缀写入（让 renumber.js 按编号排序插入）
// 关键：所有 insert 文件都使用同一个 opts.at 编号，通过批次索引前缀保证顺序
// 这样 renumber.js 排序时，所有新文件连续排在 opts.at 位置，不会与现有章节交错
const imported = []
const insertNum = opts.at
const width = Math.max(3, String(insertNum).length)
const padded = String(insertNum).padStart(width, '0')
for (let i = 0; i < contentFiles.length; i++) {
  const content = normalizeText(fs.readFileSync(contentFiles[i], fileEncodings.get(contentFiles[i]) || 'utf8'))
  const title = sanitizeTitle(opts.titles[i] || '')
  // 多章插入时加批次索引前缀 "000--title"，保证同 num 下按插入顺序排列
  const slotTitle = contentFiles.length > 1 ? `${String(i).padStart(3, '0')}--${title}` : title
  const slotName = `.__restore__第${padded}章-${slotTitle}.md`
  const slotPath = path.join(chaptersDir, slotName)

  // 写入前拒绝 symlink，防止写穿项目边界
  if (fs.existsSync(slotPath) && fs.lstatSync(slotPath).isSymbolicLink()) {
    fs.unlinkSync(slotPath)
    result.warnings.push(`${slotName} 是符号链接，已删除并替换为普通文件`)
  }

  fs.writeFileSync(slotPath, content, 'utf8')
  imported.push({ file: slotName, chars: countChars(content), num: insertNum + i })
}

result.imported = imported
writeJournal('written', { files: imported.map(i => i.file) })

// 重编号
const renumberResult = runFileSafe(process.execPath, [path.join(scriptDir, 'renumber.js'), chaptersDir])
if (renumberResult.code !== 0) {
  fail('written', `重编号失败: ${renumberResult.stderr}`)
}

if (renumberResult.stdout && renumberResult.stdout.includes('→')) {
  const renameLog = path.join(chaptersDir, `.tmp-rename-log-${Date.now()}.txt`)
  fs.writeFileSync(renameLog, renumberResult.stdout, 'utf8')

  const updateRefsResult = runFileSafe(process.execPath, [
    path.join(scriptDir, 'update-refs.js'), projectDir, renameLog
  ])
  if (updateRefsResult.code !== 0) {
    result.warnings.push('章节已导入，但引用更新未完全完成。建议先执行一次一致性巡检。')
  }
  if (updateRefsResult.stdout) result.warnings.push(updateRefsResult.stdout)

  for (const line of renumberResult.stdout.split('\n')) {
    if (line.includes('→')) result.renumbered.push(line.trim())
  }

  try { fs.unlinkSync(renameLog) } catch (_) {}
}

// 更新导入结果中的实际文件名
for (let i = 0; i < imported.length; i++) {
  const actualFile = findChapterFile(opts.at + i)
  if (actualFile) imported[i].file = path.basename(actualFile)
}

writeJournal('renumbered')

// 追加日志条目
if (opts.logEntry && fs.existsSync(opts.logEntry)) {
  const logContent = fs.readFileSync(opts.logEntry, 'utf8')
  const logFile = path.join(projectDir, 'chapter-log.md')
  if (fs.existsSync(logFile) && fs.lstatSync(logFile).isSymbolicLink()) {
    result.warnings.push('chapter-log.md 是符号链接，已跳过写入')
  } else if (fs.existsSync(logFile)) {
    let existing = fs.readFileSync(logFile, 'utf8').trimEnd()
    fs.writeFileSync(logFile, existing + '\n\n' + logContent.trim() + '\n', 'utf8')
  } else {
    fs.writeFileSync(logFile, '# 章节日志\n\n' + logContent.trim() + '\n', 'utf8')
  }
}

// 排序日志
const logFile = path.join(projectDir, 'chapter-log.md')
if (fs.existsSync(logFile)) {
  runFileSafe(process.execPath, [path.join(scriptDir, 'sort-log.js'), logFile])
}

// 更新 PROJECT.yaml
// 插入模式：如果插入位置 ≤ 原 current_chapter，指针顺移
let newCurrentChapter = origCurrentChapter
if (origCurrentFile && renumberResult.stdout) {
  for (const line of renumberResult.stdout.split('\n')) {
    if (!line.includes('→')) continue
    const [oldPart] = line.split('→').map(s => s.trim())
    if (oldPart === origCurrentFile) {
      const newMatch = line.split('→')[1].trim().match(/^第(\d+)章/)
      if (newMatch) newCurrentChapter = Number(newMatch[1])
      break
    }
  }
} else if (opts.at <= origCurrentChapter) {
  // 无重编号输出但插入在指针之前，手动偏移
  newCurrentChapter = origCurrentChapter + contentFiles.length
}

const updateArgs = [
  path.join(scriptDir, 'update-project.js'), projectDir,
  '--chapter', String(newCurrentChapter),
  '--last-action', JSON.stringify({
    type: 'import',
    targets: imported.map(i => `第${i.num}章`),
    timestamp: new Date().toISOString(),
  }),
]
for (const c of opts.characters) updateArgs.push('--add-character', c)

const updateResult = runFileSafe(process.execPath, updateArgs)
if (updateResult.code !== 0) {
  result.warnings.push(`PROJECT.yaml 更新失败 (非致命): ${updateResult.stderr}`)
}

// ── 完成 ─────────────────────────────────────────────────
try { fs.unlinkSync(journalPath) } catch (_) {}
releaseLock()
result.ok = true
console.log(JSON.stringify(result, null, 2))
