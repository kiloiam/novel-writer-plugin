#!/usr/bin/env node
/**
 * delete-chapter.js — 原子章节删除事务
 *
 * 用法：node delete-chapter.js <项目目录> <章节编号1> [章节编号2 ...]
 *   编号为纯数字（去前导零），如：node delete-chapter.js ./星渊坠落 3 5 7
 *
 * 等价于 LLM 手动执行的 6 步流程：
 *   1. archive.sh (每章) → 2. rm 原文件 → 3. 清理 chapter-log.md
 *   → 4. clean-deleted-refs.js → 5. renumber.js → 6. update-refs.js
 *
 * 事务保障：
 * - 操作日志 .__op_journal__.json 记录当前 phase
 * - 任意阶段中断可根据 phase 恢复/回滚
 * - 全部完成后自动清理日志与临时文件
 *
 * 输出 JSON：
 *   { ok: true, archived: [...], renumbered: [...], warnings: [...] }
 *   失败时 { ok: false, phase, error, journal_path }
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { acquireLock } = require('./project-lock')
const { chineseToNumber, CHAPTER_HEADING_RE, ANY_HEADING_RE } = require('./chapter-log-parser')

// ── 参数解析 ──────────────────────────────────────────────
const projectDir = process.argv[2]
const deleteNums = [...new Set(process.argv.slice(3).map(Number).filter(n => n >= 0 && !isNaN(n)))]
const forceClear = process.argv.includes('--force-clear')

if (!projectDir || !deleteNums.length) {
  console.error('用法: node delete-chapter.js <项目目录> <章节编号1> [章节编号2 ...]')
  process.exit(1)
}

if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  console.error(`ERROR: 项目目录不存在: ${projectDir}`)
  process.exit(1)
}

const chaptersDir = path.join(projectDir, 'chapters')
if (!fs.existsSync(chaptersDir)) {
  console.error(`ERROR: chapters 目录不存在: ${chaptersDir}`)
  process.exit(1)
}

// ── 项目级互斥锁 ─────────────────────────────────────────
let releaseLock
try {
  releaseLock = acquireLock(projectDir, 'delete-chapter')
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  process.exit(5)
}

// ── 预飞检查：验证 PROJECT.yaml 可读写 ───────────────────
const yamlPath = path.join(projectDir, 'PROJECT.yaml')
if (fs.existsSync(yamlPath)) {
  try {
    const stat = fs.statSync(yamlPath)
    if (!stat.isFile()) {
      console.error(`ERROR: PROJECT.yaml 不是常规文件，拒绝操作以防部分提交`)
      releaseLock()
      process.exit(8)
    }
    fs.readFileSync(yamlPath, 'utf8')
    fs.accessSync(yamlPath, fs.constants.W_OK)
  } catch (e) {
    console.error(`ERROR: PROJECT.yaml 不可访问 (${e.code || e.message})，拒绝操作`)
    releaseLock()
    process.exit(8)
  }
}

const scriptDir = __dirname
const journalPath = path.join(chaptersDir, '.__op_journal__.json')
const result = { ok: false, archived: [], renumbered: [], warnings: [], snapshot: null }

// ── 工具函数（安全进程调用，无 Shell 注入风险）─────────────
// 子进程继承项目锁状态，防止子脚本重复获取锁
const childEnv = { ...process.env, NOVEL_WRITER_LOCK_HELD: path.resolve(projectDir) }

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
  const journal = {
    op: 'delete',
    ts: new Date().toISOString(),
    targets: deleteNums.map(n => `第${n}章`),
    phase,
    detail: detail || {},
  }
  const tmpPath = journalPath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(journal, null, 2), 'utf8')
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
    console.error('请先手动确认状态或使用 --force-clear 选项清除后重试')
    fail('interrupted', `上次操作 (${op}) 未完成，phase=${phase}。可使用 --force-clear 强制清除`)
  }
}

// ── 查找目标章节文件 ──────────────────────────────────────
function findChapterFile(num) {
  const entries = fs.readdirSync(chaptersDir)
  for (const name of entries) {
    const m = name.match(/^第(\d+)章(-.+)?\.md$/)
    if (m && Number(m[1]) === num) {
      // 跳过符号链接
      const fullPath = path.join(chaptersDir, name)
      try { if (fs.lstatSync(fullPath).isSymbolicLink()) continue } catch (_) {}
      return name
    }
  }
  return null
}

const targets = []
for (const num of deleteNums) {
  const file = findChapterFile(num)
  if (!file) {
    result.warnings.push(`第${num}章 未找到对应文件，已跳过`)
  } else {
    targets.push({ num, file, path: path.join(chaptersDir, file) })
  }
}

if (!targets.length) {
  result.ok = true
  result.warnings.push('所有指定章节均未找到，无操作')
  releaseLock()
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

// ── 记录删除前的写作指针，用于重编号后跟踪 ─────────────
let origCurrentChapter = 0
let origCurrentFile = null
if (fs.existsSync(yamlPath)) {
  const m = fs.readFileSync(yamlPath, 'utf8').match(/^current_chapter:\s*(\d+)/m)
  if (m) {
    origCurrentChapter = Number(m[1])
    origCurrentFile = findChapterFile(origCurrentChapter)
  }
}

// ── Phase 0: snapshot → 删除前快照（可逆兜底）────────────
const snapshotDir = path.join(chaptersDir, '_snapshots')
const snapshotTs = new Date().toISOString().replace(/[:.]/g, '-')
const snapshotPath = path.join(snapshotDir, `delete-${deleteNums.join('_')}-${snapshotTs}`)
try {
  fs.mkdirSync(snapshotPath, { recursive: true })
  // 保存所有将被影响的文件
  const filesToSnapshot = []
  // 所有现存章节文件（不仅是被删除的，exact 回滚需要完整的章节集合）
  for (const name of fs.readdirSync(chaptersDir)) {
    if (!/^第\d+章(-.+)?\.md$/.test(name)) continue
    const p = path.join(chaptersDir, name)
    if (fs.lstatSync(p).isSymbolicLink()) continue
    filesToSnapshot.push({ src: p, rel: path.join('chapters', name) })
  }
  // 元数据文件
  for (const rel of ['PROJECT.yaml', 'chapter-log.md', 'foreshadowing.md', 'timeline.md', 'relationships.md']) {
    const p = path.join(projectDir, rel)
    if (fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink()) filesToSnapshot.push({ src: p, rel })
  }
  for (const sub of ['characters', 'outline']) {
    const subDir = path.join(projectDir, sub)
    if (!fs.existsSync(subDir)) continue
    for (const name of fs.readdirSync(subDir)) {
      if (!name.endsWith('.md')) continue
      const p = path.join(subDir, name)
      if (fs.lstatSync(p).isSymbolicLink()) continue
      filesToSnapshot.push({ src: p, rel: path.join(sub, name) })
    }
  }
  // 保存快照清单 + 逐文件复制
  const manifest = { ts: snapshotTs, op: 'delete', targets: deleteNums, files: [] }
  for (const f of filesToSnapshot) {
    const dest = path.join(snapshotPath, f.rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(f.src, dest)
    manifest.files.push(f.rel)
  }
  fs.writeFileSync(path.join(snapshotPath, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  result.snapshot = snapshotPath
} catch (e) {
  // 快照失败 = 致命错误。无快照则删除无法回滚，拒绝继续。
  // 常见原因：磁盘满（ENOSPC）、权限不足、云盘客户端锁定文件
  fail('snapshot', `删除前快照创建失败，拒绝执行删除: ${e.message}`)
}

// ── Phase 1: pre-archive → 写入日志 ──────────────────────
writeJournal('pre-archive', { targetFiles: targets.map(t => t.file), snapshot: snapshotPath })

// ── Phase 2: archived → 归档每个章节 ─────────────────────
const archived = []
for (const t of targets) {
  const r = runFileSafe(process.execPath, [path.join(scriptDir, 'archive.js'), t.path, 'deleted', chaptersDir])
  if (r.code !== 0) {
    fail('pre-archive', `归档 ${t.file} 失败: ${r.stderr}`)
  }
  archived.push({ file: t.file, archivePath: r.stdout })
}

// 删除原文件
for (const t of targets) {
  try { fs.unlinkSync(t.path) } catch (e) { /* 已被归档 */ }
}
result.archived = archived.map(a => a.file)
writeJournal('archived', { archivedFiles: archived })

// ── Phase 3: refs-cleaned → 清理 chapter-log + 元数据引用 ──
// 3a. 清理 chapter-log.md 中已删章节的条目（使用共享解析器）
const logFile = path.join(projectDir, 'chapter-log.md')
if (fs.existsSync(logFile) && !fs.lstatSync(logFile).isSymbolicLink()) {
  let logContent = fs.readFileSync(logFile, 'utf8')
  const deletedSet = new Set(targets.map(t => t.num))

  // 使用共享正则（兼容 #/##/### 层级）
  const lines = logContent.split('\n')
  const filtered = []
  let skip = false
  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(CHAPTER_HEADING_RE)
    if (headingMatch) {
      const chNum = chineseToNumber(headingMatch[1])
      skip = deletedSet.has(chNum)
      if (skip) continue
    } else if (skip && ANY_HEADING_RE.test(lines[i])) {
      // 下一个 heading，停止跳过
      skip = false
    }
    if (!skip) filtered.push(lines[i])
  }

  // 去除结尾多余空行
  let cleanedLog = filtered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  fs.writeFileSync(logFile, cleanedLog, 'utf8')
}

// 3b. 清理元数据引用（使用 clean-deleted-refs.js）
const numsFile = path.join(chaptersDir, `.tmp-deleted-nums-${Date.now()}.txt`)
fs.writeFileSync(numsFile, targets.map(t => String(t.num)).join('\n') + '\n', 'utf8')

const cleanResult = runFileSafe(process.execPath, [path.join(scriptDir, 'clean-deleted-refs.js'), projectDir, numsFile])
try { fs.unlinkSync(numsFile) } catch (e) { /* best-effort */ }

if (cleanResult.code !== 0) {
  fail('archived', `清理元数据引用失败: ${cleanResult.stderr}`)
}
if (cleanResult.stdout) result.warnings.push(cleanResult.stdout)

writeJournal('refs-cleaned')

// ── Phase 4: renumbered → 重编号 ─────────────────────────
const renameLog = path.join(chaptersDir, `.tmp-rename-log-${Date.now()}.txt`)

const renumberResult = runFileSafe(process.execPath, [path.join(scriptDir, 'renumber.js'), chaptersDir])
if (renumberResult.code !== 0) {
  fail('refs-cleaned', `重编号失败: ${renumberResult.stderr}`)
}

// 保存重编号映射
if (renumberResult.stdout) {
  fs.writeFileSync(renameLog, renumberResult.stdout, 'utf8')
}

// 更新全局引用
if (renumberResult.stdout && renumberResult.stdout.includes('→')) {
  const updateResult = runFileSafe(process.execPath, [path.join(scriptDir, 'update-refs.js'), projectDir, renameLog])
  if (updateResult.code !== 0) {
    result.warnings.push(`全局引用更新失败 (非致命): ${updateResult.stderr}`)
  }
  if (updateResult.stdout) result.warnings.push(updateResult.stdout)

  // 解析重编号结果
  for (const line of renumberResult.stdout.split('\n')) {
    if (line.includes('→')) result.renumbered.push(line.trim())
  }
}

try { fs.unlinkSync(renameLog) } catch (e) { /* best-effort */ }

writeJournal('renumbered')

// ── Phase 5: 排序日志 ────────────────────────────────────
if (fs.existsSync(logFile)) {
  runFileSafe(process.execPath, [path.join(scriptDir, 'sort-log.js'), logFile])
}

// ── Phase 6: 自动更新 PROJECT.yaml ───────────────────────
const updateProjectJs = path.join(scriptDir, 'update-project.js')
if (fs.existsSync(updateProjectJs)) {
  // 计算删除后 current_chapter 应该跟踪的新编号
  let newCurrentChapter = 0
  const deletedSet = new Set(deleteNums)

  if (origCurrentFile && !deletedSet.has(origCurrentChapter)) {
    // 原指针章节未被删除 → 从重编号映射中查找它的新编号
    // 重编号映射格式："第003章-高潮.md → 第002章-高潮.md"
    let tracked = false
    if (renumberResult.stdout) {
      for (const line of renumberResult.stdout.split('\n')) {
        if (!line.includes('→')) continue
        const [oldPart] = line.split('→').map(s => s.trim())
        if (oldPart === origCurrentFile) {
          const newMatch = line.split('→')[1].trim().match(/^第(\d+)章/)
          if (newMatch) {
            newCurrentChapter = Number(newMatch[1])
            tracked = true
          }
          break
        }
      }
    }
    if (!tracked) {
      // 没有重编号变化（或不在映射中），直接扫描当前文件的编号
      const stillExists = findChapterFile(origCurrentChapter)
      if (stillExists) {
        const m = stillExists.match(/^第(\d+)章/)
        newCurrentChapter = m ? Number(m[1]) : origCurrentChapter
      }
    }
  } else {
    // 原指针章节被删了 → fallback: min(原编号, 现存最大编号)
    const remaining = fs.readdirSync(chaptersDir)
      .map(n => (n.match(/^第(\d+)章(-.+)?\.md$/) || [])[1])
      .filter(Boolean)
      .map(Number)
    const maxChapter = remaining.length ? Math.max(...remaining) : 0
    newCurrentChapter = Math.min(origCurrentChapter, maxChapter)
  }

  const updateArgs = [
    updateProjectJs, projectDir,
    '--chapter', String(newCurrentChapter),
    '--last-action', JSON.stringify({
      type: 'delete',
      targets: deleteNums.map(n => `第${n}章`),
      timestamp: new Date().toISOString(),
    }),
  ]

  const updateResult = runFileSafe(process.execPath, updateArgs)
  if (updateResult.code !== 0) {
    result.warnings.push(`PROJECT.yaml 更新失败 (非致命): ${updateResult.stderr}`)
  }
}

// ── 完成：清理操作日志 ───────────────────────────────────
try { fs.unlinkSync(journalPath) } catch (e) { /* already gone */ }

releaseLock()
result.ok = true
console.log(JSON.stringify(result, null, 2))
