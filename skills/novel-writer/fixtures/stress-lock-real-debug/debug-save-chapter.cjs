#!/usr/bin/env node
/**
 * save-chapter.js — 章节保存网关（Post-hooks 自动化）
 *
 * 用法：
 *   node save-chapter.js <项目目录> <章节编号> <正文文件> [选项...]
 *
 * 选项：
 *   --title <标题>              章节标题（用于文件名，会自动净化）
 *   --log-entry <文件>          章节日志条目文件（追加到 chapter-log.md）
 *   --characters <A,B,C>       本章活跃角色（合并到 active_characters）
 *   --plotlines <主线:X,支线:Y> 本章情节线（合并到 focus_plotlines）
 *   --clear-note               清空 next_chapter_note
 *   --archive-type <type>      归档类型（默认 write；润色用 polish，重写用 rewrite）
 *
 * 自动执行的 Post-hooks：
 *   1. 覆盖保护：目标文件已存在时自动归档旧版本
 *   2. 净化文件名
 *   3. 保存正文到 chapters/第XXX章-标题.md
 *   4. 统计字数（去除 markdown 语法后的纯字符数）
 *   5. 追加章节日志（如提供 --log-entry）
 *   6. 更新 PROJECT.yaml（current_chapter、status、updated、active_characters、last_action）
 *
 * 输出 JSON：
 *   { ok, file, chars, archived, updated_fields }
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { acquireLock, buildInheritedLockEnvFromProject } = require('D:\\Agent\\Open-ClaudeCode\\.claude\\skills\\novel-writer\\fixtures\\stress-lock-real-debug\\debug-project-lock.cjs')
console.error('DEBUG_LOCK_MODULE=' + require.resolve('D:\\Agent\\Open-ClaudeCode\\.claude\\skills\\novel-writer\\fixtures\\stress-lock-real-debug\\debug-project-lock.cjs'))
const { readUtf8TextChecked } = require('D:\\Agent\\Open-ClaudeCode\\.claude\\skills\\novel-writer\\scripts\\text-utils.js')
const { chineseToNumber, CHAPTER_HEADING_RE, ANY_HEADING_RE } = require('D:\\Agent\\Open-ClaudeCode\\.claude\\skills\\novel-writer\\scripts\\chapter-log-parser.js')

// ── 参数解析 ──────────────────────────────────────────────
const projectDir = process.argv[2]
const chapterNum = Number(process.argv[3])
const contentFile = process.argv[4]

if (!projectDir || !Number.isInteger(chapterNum) || chapterNum < 0 || !contentFile) {
  console.error('用法: node save-chapter.js <项目目录> <章节编号> <正文文件> [选项...]')
  process.exit(1)
}

if (!fs.existsSync(projectDir)) { console.error(`ERROR: 项目目录不存在: ${projectDir}`); process.exit(1) }
if (!fs.existsSync(contentFile)) { console.error(`ERROR: 正文文件不存在: ${contentFile}`); process.exit(1) }

// ── 项目级互斥锁 ─────────────────────────────────────────
let releaseLock
try {
  releaseLock = acquireLock(projectDir, 'save-chapter')
} catch (e) {
  console.error('DEBUG_RAW_LOCK_ERROR=' + e.message)
  console.error(`ERROR: ${e.message}`)
  process.exit(5)
}

const scriptDir = __dirname
const args = process.argv.slice(5)
const opts = {
  title: '',
  logEntry: null,
  characters: [],
  plotlines: [],
  clearNote: false,
  archiveType: 'write',
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  const next = () => { if (i + 1 >= args.length) { console.error(`ERROR: ${arg} 需要一个值`); process.exit(1) }; return args[++i] }
  switch (arg) {
    case '--title': opts.title = next(); break
    case '--log-entry': opts.logEntry = next(); break
    case '--characters': opts.characters = next().split(',').map(s => s.trim()).filter(Boolean); break
    case '--plotlines': opts.plotlines = next().split(',').map(s => s.trim()).filter(Boolean); break
    case '--clear-note': opts.clearNote = true; break
    case '--archive-type': opts.archiveType = next(); break
    case '--force-clear': break // 已在前面处理
    default: console.error(`WARNING: 忽略未知选项 ${arg}`); break
  }
}

const chaptersDir = path.join(projectDir, 'chapters')
if (!fs.existsSync(chaptersDir)) fs.mkdirSync(chaptersDir, { recursive: true })

if (opts.logEntry) {
  const resolvedLogEntry = path.resolve(opts.logEntry)
  const resolvedProjectDir = path.resolve(projectDir)
  if (!resolvedLogEntry.startsWith(resolvedProjectDir + path.sep) && resolvedLogEntry !== path.join(resolvedProjectDir, path.basename(resolvedLogEntry))) {
    console.error(`ERROR: --log-entry 路径越界: ${opts.logEntry}`)
    releaseLock()
    process.exit(1)
  }
  opts.logEntry = resolvedLogEntry
}

// ── 中断日志检查：拒绝在未完成事务状态下写入 ────────────
const journalPath = path.join(chaptersDir, '.__op_journal__.json')
if (fs.existsSync(journalPath)) {
  const forceClear = process.argv.includes('--force-clear')
  if (forceClear) {
    console.error('WARNING: --force-clear 强制清除残留操作日志')
    try { fs.unlinkSync(journalPath) } catch (_) {}
  } else {
    try {
      const existing = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
      console.error(`ERROR: 检测到未完成的操作日志 (op: ${existing.op}, phase: ${existing.phase})`)
    } catch (_) {
      console.error('ERROR: 检测到残留的操作日志文件')
    }
    console.error('项目处于未完成事务状态，拒绝保存。请先检查或使用 --force-clear 清除')
    releaseLock()
    process.exit(7)
  }
}

const yamlPreflightPath = path.join(projectDir, 'PROJECT.yaml')
if (fs.existsSync(yamlPreflightPath)) {
  try {
    const stat = fs.statSync(yamlPreflightPath)
    if (!stat.isFile()) {
      console.error(`ERROR: PROJECT.yaml 不是常规文件（可能是目录），拒绝保存`)
      releaseLock()
      process.exit(8)
    }
    // 验证可读
    fs.readFileSync(yamlPreflightPath, 'utf8')
    // 验证可写
    fs.accessSync(yamlPreflightPath, fs.constants.W_OK)
  } catch (e) {
    if (e.code) {
      console.error(`ERROR: PROJECT.yaml 不可访问 (${e.code})，拒绝保存以防部分提交`)
    } else {
      console.error(`ERROR: PROJECT.yaml 预检失败: ${e.message}`)
    }
    releaseLock()
    process.exit(8)
  }
}

const result = { ok: false, file: '', chars: 0, archived: null, updated_fields: [] }

// ── 净化文件名 ────────────────────────────────────────────
function sanitizeTitle(title) {
  if (!title) return '无题'
  let safe = title
    .replace(/[\x00-\x1f]/g, '')       // 控制字符
    .replace(/[\\/:*?"<>|]/g, '-')      // 文件系统非法字符
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')                 // 开头的点
    .replace(/-{2,}/g, '-')              // 连续 - 折叠
    .replace(/^-+/, '')                   // 开头的 -
    .replace(/-+$/, '')                   // 末尾的 -
    .replace(/\.+$/, '')                 // 末尾的点（Windows 不允许）
    .slice(0, 60)
  // Windows 保留名（含带后缀形式如 AUX.txt）
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\..*)?$/i.test(safe)) safe = '_' + safe
  return safe || '无题'
}

// ── 统计字数 ──────────────────────────────────────────────
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

// ── 查找现有章节文件 ─────────────────────────────────────
function findExistingChapter(num) {
  for (const name of fs.readdirSync(chaptersDir)) {
    const m = name.match(/^第(\d+)章(-.+)?\.md$/)
    if (m && Number(m[1]) === num) {
      const fullPath = path.join(chaptersDir, name)
      // 拒绝符号链接，防止通过 symlink 越权读写项目外文件
      if (fs.lstatSync(fullPath).isSymbolicLink()) continue
      return fullPath
    }
  }
  return null
}

// ── 1. 覆盖保护：归档旧版本 ─────────────────────────────
try {
  const childEnv = buildInheritedLockEnvFromProject(projectDir, process.env)
  const existingFile = findExistingChapter(chapterNum)
if (existingFile) {
  try {
    // JS-first：优先使用 archive.js（跨平台）
    const archiveResult = execFileSync(process.execPath, [
      path.join(scriptDir, 'archive.js'), existingFile, opts.archiveType, chaptersDir
    ], { encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    result.archived = archiveResult
  } catch (e) {
    // archive.js 失败，尝试 bash fallback
    try {
      const archiveResult = execFileSync('bash', [
        path.join(scriptDir, 'archive.sh'), existingFile, opts.archiveType, chaptersDir
      ], { encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
      result.archived = archiveResult
    } catch (e2) {
      // 最后手段：手动复制
      const d = new Date()
      const pad = n => String(n).padStart(2, '0')
      const ts = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3,'0')}`
      const histDir = path.join(chaptersDir, '_history')
      fs.mkdirSync(histDir, { recursive: true })
      const bak = path.join(histDir, `${path.basename(existingFile, '.md')}--${ts}--${opts.archiveType}.md`)
      fs.copyFileSync(existingFile, bak)
      result.archived = bak
    }
  }
}

// ── 2. 保存正文 ─────────────────────────────────────────
let content
try {
  content = readUtf8TextChecked(contentFile)
} catch (e) {
  if (e.code === 'INVALID_UTF8') {
    console.error(`ERROR: ${e.message}`)
    console.error('请先将文件转换为 UTF-8 编码后重试（可使用 iconv 或编辑器另存为 UTF-8）')
    releaseLock()
    process.exit(1)
  }
  throw e
}
const safeTitle = sanitizeTitle(opts.title)
const width = Math.max(3, String(chapterNum).length)
const padded = String(chapterNum).padStart(width, '0')
const fileName = `第${padded}章-${safeTitle}.md`
const targetPath = path.join(chaptersDir, fileName)

// 如果存在旧文件且文件名不同，删除旧文件
if (existingFile && existingFile !== targetPath) {
  try { fs.unlinkSync(existingFile) } catch (e) { /* already gone */ }
}

// 写入前检查目标路径是否为 symlink，防止写穿项目边界
if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) {
  fs.unlinkSync(targetPath) // 删除 symlink，后续 writeFileSync 会创建普通文件
  result.warnings = result.warnings || []
  result.warnings.push(`${fileName} 是符号链接，已删除并替换为普通文件`)
}

fs.writeFileSync(targetPath, content, 'utf8')
result.file = fileName
result.chars = countChars(content)

// ── 3. 追加章节日志（覆盖保存时先移除同章旧条目）────────
if (opts.logEntry && fs.existsSync(opts.logEntry)) {
  const logContent = fs.readFileSync(opts.logEntry, 'utf8')
  const logFile = path.join(projectDir, 'chapter-log.md')
  // 拒绝 symlink，防止写穿项目边界
  if (fs.existsSync(logFile) && fs.lstatSync(logFile).isSymbolicLink()) {
    result.warnings = result.warnings || []
    result.warnings.push('chapter-log.md 是符号链接，已跳过写入')
  } else if (fs.existsSync(logFile)) {
    // 移除同章旧条目，防止重复（使用共享解析器，兼容 #/##/### 层级）
    let existing = fs.readFileSync(logFile, 'utf8')
    const lines = existing.split('\n')
    const filtered = []
    let skip = false
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CHAPTER_HEADING_RE)
      if (m && chineseToNumber(m[1]) === chapterNum) {
        skip = true
        continue
      }
      if (skip && ANY_HEADING_RE.test(lines[i])) {
        skip = false
      }
      if (!skip) filtered.push(lines[i])
    }
    existing = filtered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
    fs.writeFileSync(logFile, existing + '\n\n' + logContent.trim() + '\n', 'utf8')
  } else {
    fs.writeFileSync(logFile, '# 章节日志\n\n' + logContent.trim() + '\n', 'utf8')
  }
  result.updated_fields.push('chapter-log')
  // 标准化日志排序和空行
  try {
    execFileSync(process.execPath, [path.join(scriptDir, 'sort-log.js'), logFile],
      { encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (_) {}
}

// ── 4. 更新 PROJECT.yaml ────────────────────────────────
const updateArgs = [
  path.join(scriptDir, 'update-project.js'), projectDir,
  '--chapter', String(chapterNum),
  '--last-action', JSON.stringify({
    type: opts.archiveType === 'polish' ? 'polish' : opts.archiveType === 'rewrite' ? 'rewrite' : 'write',
    target: `第${padded}章`,
    timestamp: new Date().toISOString(),
  }),
]

// 自动 status 流转
if (fs.existsSync(yamlPreflightPath)) {
  const yamlContent = fs.readFileSync(yamlPreflightPath, 'utf8')
  const statusMatch = yamlContent.match(/^status:\s*(\S+)/m)
  if (statusMatch) {
    const current = statusMatch[1]
    if ((current === 'planning' || current === 'polishing' || current === 'completed') && opts.archiveType === 'write') {
      updateArgs.push('--status', 'writing')
    }
  }
}

// 合并活跃角色
for (const c of opts.characters) {
  updateArgs.push('--add-character', c)
}

// 合并情节线
for (const p of opts.plotlines) {
  updateArgs.push('--add-plotline', p)
}

// 清空备注
if (opts.clearNote) {
  updateArgs.push('--next-note', '')
}

try {
  execFileSync(process.execPath, updateArgs, { encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  result.updated_fields.push('PROJECT.yaml')
} catch (e) {
  result.warnings = result.warnings || []
  result.warnings.push(`PROJECT.yaml 更新失败: ${e.stderr || e.message}`)
}

// ── 完成 ─────────────────────────────────────────────────
result.ok = true
} catch (e) {
  result.error = e.message
} finally {
  releaseLock()
}
console.log(JSON.stringify(result, null, 2))
