#!/usr/bin/env node
/**
 * sync-edit.js — 手工编辑同步：原子提交正文与必需元数据
 *
 * 用法：
 *   node sync-edit.js <项目目录> [章节编号] [--log-entry-file <文件>]
 *
 * 如果不提供章节编号，自动查找所有编辑标记并同步。
 *
 * 流程：
 *   1. 查找编辑标记 (.edit-marker-*.json)
 *   2. 如果标记中 edit_format="docx"，先将 .docx 转回 .md（docx→md）
 *   3. 读取当前章节内容，规范化（CRLF→LF、去BOM）
 *   4. 比对哈希检测变更
 *   5. 若全部变更章节都具备日志输入且无失败项：提交 chapter-log 与 PROJECT.yaml
 *   6. 若变更后无法完成必需同步步骤：保存用户编辑内容为草稿快照，并自动回撤到 pre-edit
 *
 * 输出 JSON：
 *   {
 *     ok,
 *     status,
 *     rolled_back,
 *     draft_snapshots,
 *     synced: [{ chapter_num, chapter_file, changed, old_chars, new_chars, edit_format }]
 *   }
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { acquireLock } = require('./project-lock')
const { normalizeText } = require('./text-utils')
const { chineseToNumber, CHAPTER_HEADING_RE, ANY_HEADING_RE } = require('./chapter-log-parser')

const projectDir = process.argv[2]
const args = process.argv.slice(3)
let specifiedChapter = null
let logEntryFile = null

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--log-entry-file' && i + 1 < args.length) {
    logEntryFile = args[++i]
  } else if (specifiedChapter === null && /^\d+$/.test(arg)) {
    specifiedChapter = Number(arg)
  }
}

if (!projectDir) {
  console.error('用法: node sync-edit.js <项目目录> [章节编号] [--log-entry-file <文件>]')
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

const draftDir = path.join(chaptersDir, '_drafts')
const logFile = path.join(projectDir, 'chapter-log.md')

function countChars(text) {
  const clean = text
    .replace(/^#.*$/gm, '')
    .replace(/^---$/gm, '')
    .replace(/^>/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/\*\*/g, '')
    .replace(/[*_~]/g, '')
  return clean.replace(/\s/g, '').length
}

function formatTimestamp(d) {
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`
}

function findChapterFile(num) {
  for (const name of fs.readdirSync(chaptersDir)) {
    const m = name.match(/^第(\d+)章(-.+)?\.md$/)
    if (m && Number(m[1]) === num) {
      const fullPath = path.join(chaptersDir, name)
      if (fs.lstatSync(fullPath).isSymbolicLink()) continue
      return fullPath
    }
  }
  return null
}

function saveDraftSnapshot(chapterFile, content) {
  fs.mkdirSync(draftDir, { recursive: true })
  const draftPath = path.join(draftDir, `${path.basename(chapterFile, '.md')}--${formatTimestamp(new Date())}--manual-edit-draft.md`)
  fs.writeFileSync(draftPath, content, 'utf8')
  return draftPath
}

function restorePreEdit(marker, chapterFile) {
  const recoverySources = [marker.data.preimage_path, marker.data.archived_path].filter(Boolean)
  for (const recoveryPath of recoverySources) {
    if (!fs.existsSync(recoveryPath)) continue
    const restoredContent = normalizeText(fs.readFileSync(recoveryPath, 'utf8'))
    fs.writeFileSync(chapterFile, restoredContent, 'utf8')
    return recoveryPath
  }
  throw new Error(`缺少可用 pre-edit 恢复源，无法回撤: ${recoverySources.join(' | ') || '(未记录)'}`)
}

function cleanupTransientFiles(marker) {
  try { fs.unlinkSync(marker.path) } catch (_) {}
  if (marker.data.docx_path) {
    const residualDocx = path.join(chaptersDir, marker.data.docx_path)
    if (fs.existsSync(residualDocx)) {
      try { fs.unlinkSync(residualDocx) } catch (_) {}
    }
  }
  if (marker.data.preimage_path && fs.existsSync(marker.data.preimage_path)) {
    try { fs.unlinkSync(marker.data.preimage_path) } catch (_) {}
  }
}

function appendLogWithDedup(logFilePath, newLogContent, chapterNums) {
  if (fs.existsSync(logFilePath) && fs.lstatSync(logFilePath).isSymbolicLink()) return false
  if (!fs.existsSync(logFilePath)) {
    if (!newLogContent.trim()) return false
    fs.writeFileSync(logFilePath, '# 章节日志\n\n' + newLogContent.trim() + '\n', 'utf8')
    return true
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
  return true
}

function buildLogEntry(chapterNum, chapterFileName, content) {
  const titleMatch = chapterFileName.match(/^第\d+章-(.+)\.md$/)
  const title = titleMatch ? titleMatch[1] : '未命名章节'
  const chars = countChars(content)
  const paragraphs = content.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  const summary = paragraphs[0]
    ? paragraphs[0].replace(/^#+\s*/, '').slice(0, 90)
    : '本章完成手工编辑同步。'
  const eventCandidates = paragraphs.slice(0, 3).map(p => p.replace(/^#+\s*/, '').slice(0, 60)).filter(Boolean)
  const eventLines = eventCandidates.length > 0
    ? eventCandidates.map(line => `  - ${line}`)
    : ['  - 本章内容已完成手工编辑同步']
  return [
    `## 第${chapterNum}章 - ${title}`,
    `- **概况**：${summary}`,
    '- **关键事件**：',
    ...eventLines,
    '- **人物变化**：待后续细化',
    '- **伏笔**：待后续细化',
    `- **字数**：约${chars}字`,
    `- **手工编辑**：${new Date().toISOString().slice(0, 10)}`,
  ].join('\n')
}

const markers = []
for (const name of fs.readdirSync(chaptersDir)) {
  const m = name.match(/^\.edit-marker-(\d+)\.json$/)
  if (!m) continue
  const num = Number(m[1])
  if (specifiedChapter !== null && num !== specifiedChapter) continue
  const markerPath = path.join(chaptersDir, name)
  try {
    const data = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    markers.push({ num, path: markerPath, data })
  } catch (e) {
    console.error(`WARNING: 编辑标记文件损坏: ${name}`)
  }
}

if (markers.length === 0) {
  const msg = specifiedChapter !== null
    ? `未找到第${specifiedChapter}章的编辑标记`
    : '未找到任何编辑标记'
  console.log(JSON.stringify({ ok: true, status: 'no_marker', rolled_back: false, draft_snapshots: [], synced: [], message: msg }, null, 2))
  process.exit(0)
}

let releaseLock
try {
  releaseLock = acquireLock(projectDir, 'sync-edit')
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  process.exit(5)
}

const childEnv = { ...process.env, NOVEL_WRITER_LOCK_HELD: path.resolve(projectDir) }

const result = {
  ok: false,
  status: 'error',
  rolled_back: false,
  draft_snapshots: [],
  synced: []
}

try {
  const changedMarkers = []
  const failedMarkers = []
  const rollbackUnavailableMarkers = []

  for (const marker of markers) {
    const syncItem = {
      chapter_num: marker.num,
      chapter_file: marker.data.chapter_file,
      changed: false,
      old_chars: marker.data.original_chars,
      new_chars: marker.data.original_chars
    }

    const chapterFile = findChapterFile(marker.num)
    if (!chapterFile) {
      syncItem.error = '章节文件不存在（可能已被删除或重编号）'
      failedMarkers.push({ marker, chapterFile: null, content: '', syncItem, shouldSaveDraft: false })
      result.synced.push(syncItem)
      continue
    }

    syncItem.chapter_file = path.basename(chapterFile)

    const preimagePath = marker.data.preimage_path
    const archivedPath = marker.data.archived_path
    const rollbackAvailable = !!(
      (preimagePath && fs.existsSync(preimagePath)) ||
      (archivedPath && fs.existsSync(archivedPath))
    )
    if (!rollbackAvailable) {
      syncItem.error = `缺少可用 pre-edit 恢复源，无法安全回撤: ${[preimagePath, archivedPath].filter(Boolean).join(' | ') || '(未记录)'}`
      syncItem.rollback_unavailable = true
      rollbackUnavailableMarkers.push({ marker, chapterFile, syncItem })
      result.synced.push(syncItem)
      continue
    }

    const editFormat = marker.data.edit_format || 'md'
    syncItem.edit_format = editFormat

    if (editFormat === 'docx') {
      const docxFileName = marker.data.docx_path
      if (!docxFileName) {
        syncItem.error = '编辑标记中缺少 docx_path 字段'
        failedMarkers.push({ marker, chapterFile, content: '', syncItem, shouldSaveDraft: false })
        result.synced.push(syncItem)
        continue
      }

      const docxFullPath = path.join(chaptersDir, docxFileName)
      if (!fs.existsSync(docxFullPath)) {
        syncItem.error = `docx 文件不存在: ${docxFileName}（可能已被移动或删除）`
        failedMarkers.push({ marker, chapterFile, content: '', syncItem, shouldSaveDraft: false })
        result.synced.push(syncItem)
        continue
      }

      const { docxToMd } = require('./docx-utils')
      let convertedMd
      try {
        convertedMd = docxToMd(docxFullPath)
      } catch (e) {
        syncItem.error = (e.code === 'EBUSY' || e.code === 'EPERM')
          ? 'docx 文件被占用，请先关闭 WPS/Word 后重试'
          : `docx 转换失败: ${e.message}`
        failedMarkers.push({ marker, chapterFile, content: '', syncItem, shouldSaveDraft: false })
        result.synced.push(syncItem)
        continue
      }

      const normalizedMd = normalizeText(convertedMd)
      fs.writeFileSync(chapterFile, normalizedMd, 'utf8')
      try { fs.unlinkSync(docxFullPath) } catch (_) {}
      syncItem.docx_cleaned = true
    }

    const rawContent = fs.readFileSync(chapterFile, 'utf8')
    if (editFormat === 'md') {
      const firstBytes = rawContent.slice(0, 50)
      const isBinary = firstBytes.includes('PK\x03\x04')
        || firstBytes.includes('{\\rtf')
        || /^\s*<(!DOCTYPE|html)/i.test(firstBytes)
        || firstBytes.includes('\x00')
      if (isBinary) {
        syncItem.error = '章节文件疑似被富文本编辑器覆盖为非文本格式，请恢复后重试'
        syncItem.corrupted = true
        failedMarkers.push({ marker, chapterFile, content: rawContent, syncItem, shouldSaveDraft: true })
        result.synced.push(syncItem)
        continue
      }
    }

    const content = normalizeText(rawContent)
    if (content !== rawContent) {
      fs.writeFileSync(chapterFile, content, 'utf8')
    }

    const newHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex')
    const newChars = countChars(content)
    syncItem.new_chars = newChars

    if (newHash !== marker.data.original_hash) {
      syncItem.changed = true
      changedMarkers.push({ marker, chapterFile, content, syncItem })
    }

    result.synced.push(syncItem)
  }

  if (rollbackUnavailableMarkers.length > 0) {
    result.ok = false
    result.status = 'rollback_unavailable_missing_pre_edit_snapshot'
    result.rollback_unavailable = true
    result.message = '检测到缺失的 pre-edit 恢复源。为避免留下不可控状态，本次同步已中止，未自动提交也未清理编辑标记。'
    console.log(JSON.stringify(result, null, 2))
    process.exit(2)
  }

  if (changedMarkers.length === 0 && failedMarkers.length === 0) {
    for (const marker of markers) {
      cleanupTransientFiles(marker)
    }
    result.status = 'no_change'
    result.ok = true
    console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  }

  if (failedMarkers.length === 0 && changedMarkers.length > 0) {
    try {
      const chapterNums = changedMarkers.map(item => item.marker.num)
      let logContent = ''
      if (logEntryFile && fs.existsSync(logEntryFile)) {
        logContent = fs.readFileSync(logEntryFile, 'utf8')
      } else {
        logContent = changedMarkers.map(item => buildLogEntry(item.marker.num, item.syncItem.chapter_file, item.content)).join('\n\n')
      }
      const wroteLog = appendLogWithDedup(logFile, logContent, chapterNums)
      if (wroteLog && fs.existsSync(logFile)) {
        execFileSync(process.execPath, [path.join(__dirname, 'sort-log.js'), logFile], {
          encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe']
        })
      }

      const updateArgs = [
        path.join(__dirname, 'update-project.js'), projectDir,
        '--chapter', String(Math.max(...chapterNums)),
        '--last-action', JSON.stringify({
          type: 'manual-edit',
          targets: chapterNums.map(num => `第${num}章`),
          affected_files: ['chapter-log.md'],
          timestamp: new Date().toISOString(),
        }),
      ]

      execFileSync(process.execPath, updateArgs, {
        encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe']
      })

      for (const marker of markers) {
        cleanupTransientFiles(marker)
      }

      result.ok = true
      result.status = 'committed_manual_edit'
      console.log(JSON.stringify(result, null, 2))
      process.exit(0)
    } catch (e) {
      result.warnings = result.warnings || []
      result.warnings.push(`成功提交失败，转入回撤: ${(e.stderr || e.message).slice(0, 200)}`)
    }
  }

  const rollbackItems = [...changedMarkers, ...failedMarkers]

  for (const item of rollbackItems) {
    const { marker, chapterFile, content, syncItem, shouldSaveDraft = true } = item
    if (shouldSaveDraft && chapterFile && content) {
      const draftPath = saveDraftSnapshot(chapterFile, content)
      result.draft_snapshots.push(draftPath)
      syncItem.draft_snapshot = draftPath
    }
    if (chapterFile) {
      restorePreEdit(marker, chapterFile)
      syncItem.rolled_back = true
    }
  }

  for (const marker of markers) {
    cleanupTransientFiles(marker)
  }

  const rollbackTargets = rollbackItems.map(({ marker }) => `第${marker.num}章`)
  try {
    execFileSync(process.execPath, [
      path.join(__dirname, 'update-project.js'), projectDir,
      '--last-action', JSON.stringify({
        type: 'manual-edit-rolled-back',
        targets: rollbackTargets,
        timestamp: new Date().toISOString(),
        draft_snapshots: result.draft_snapshots.map(p => path.relative(projectDir, p).replace(/\\/g, '/')),
      }),
    ], {
      encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (e) {
    result.warnings = result.warnings || []
    result.warnings.push(`PROJECT.yaml 回撤状态写入失败: ${(e.stderr || e.message).slice(0, 200)}`)
  }

  result.ok = true
  result.rolled_back = true
  result.status = failedMarkers.length > 0
    ? 'rolled_back_after_sync_failure_with_draft_snapshot'
    : 'rolled_back_to_pre_edit_with_draft_snapshot'
} catch (e) {
  result.error = e.message
} finally {
  releaseLock()
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(2)
