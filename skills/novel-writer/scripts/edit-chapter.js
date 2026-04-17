#!/usr/bin/env node
/**
 * edit-chapter.js — 手工编辑准备：归档当前版本 + 创建编辑标记
 *
 * 用法：
 *   node edit-chapter.js <项目目录> <章节编号> [--editor <编辑器命令>]
 *
 * 流程：
 *   1. 查找章节文件
 *   2. 规范化文本（CRLF→LF、去BOM）
 *   3. 归档当前版本（操作类型 pre-edit）
 *   4. 创建编辑标记文件 .edit-marker-<编号>.json
 *   5. 如果 --editor 指定了富文本编辑器（WPS/Word 等），自动生成 .edit.docx
 *   6. 返回章节文件路径 + open_path（供 LLM 打开编辑器）
 *
 * 输出 JSON：
 *   { ok, chapter_file, chapter_path, open_path, marker_path, archived, chars, edit_format }
 *   - open_path: 实际应传给编辑器的文件路径（富文本编辑器时为 .docx，否则同 chapter_path）
 *   - edit_format: "md" 或 "docx"
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { acquireLock } = require('./project-lock')
const { normalizeText } = require('./text-utils')

// ── 富文本编辑器检测集合 ──────────────────────────────────
// 这些编辑器会将 .md 保存为富文本格式，破坏 Markdown 结构
// 当检测到这些编辑器时，自动转换 md→docx 供编辑，同步时再转回
const RICH_TEXT_EDITORS = new Set([
  'wps', 'word', 'winword',        // WPS / Microsoft Word
  'ksolaunch',                       // WPS Office 启动器（金山）
  'libreoffice', 'soffice', 'lowriter', // LibreOffice
  'abiword',                         // AbiWord
  'pages',                           // macOS Pages
])

/**
 * 判断编辑器命令是否为富文本编辑器
 * 取命令的 basename（去掉路径和 .exe 后缀），转小写比对
 */
function isRichTextEditor(editorCmd) {
  if (!editorCmd) return false
  const base = path.basename(editorCmd).replace(/\.exe$/i, '').toLowerCase()
  return RICH_TEXT_EDITORS.has(base)
}

// ── 参数解析 ──────────────────────────────────────────────
const args = process.argv.slice(2)
let projectDir = null
let chapterNum = NaN
let editorCmd = ''

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--editor' && i + 1 < args.length) {
    editorCmd = args[++i]
  } else if (!projectDir) {
    projectDir = args[i]
  } else if (isNaN(chapterNum)) {
    chapterNum = Number(args[i])
  }
}

if (!projectDir || isNaN(chapterNum) || chapterNum < 0) {
  console.error('用法: node edit-chapter.js <项目目录> <章节编号> [--editor <编辑器命令>]')
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

// ── 预飞检查：验证 PROJECT.yaml 可读写 ───────────────────
const yamlPath = path.join(projectDir, 'PROJECT.yaml')
if (fs.existsSync(yamlPath)) {
  try {
    const stat = fs.statSync(yamlPath)
    if (!stat.isFile()) {
      console.error('ERROR: PROJECT.yaml 不是常规文件')
      process.exit(8)
    }
    fs.readFileSync(yamlPath, 'utf8')
    fs.accessSync(yamlPath, fs.constants.W_OK)
  } catch (e) {
    console.error(`ERROR: PROJECT.yaml 不可访问 (${e.code || e.message})`)
    process.exit(8)
  }
}

// ── 项目级互斥锁 ─────────────────────────────────────────
let releaseLock
try {
  releaseLock = acquireLock(projectDir, 'edit-chapter')
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  process.exit(5)
}

const result = { ok: false }

try {
  // ── 查找章节文件 ─────────────────────────────────────────
  let chapterFile = null
  for (const name of fs.readdirSync(chaptersDir)) {
    const m = name.match(/^第(\d+)章(-.+)?\.md$/)
    if (m && Number(m[1]) === chapterNum) {
      const fullPath = path.join(chaptersDir, name)
      if (fs.lstatSync(fullPath).isSymbolicLink()) continue
      chapterFile = fullPath
      break
    }
  }

  if (!chapterFile) {
    result.error = `未找到第${chapterNum}章`
    releaseLock()
    console.log(JSON.stringify(result, null, 2))
    process.exit(2)
  }

  // ── 读取并规范化内容 ────────────────────────────────────
  const rawContent = fs.readFileSync(chapterFile, 'utf8')
  const content = normalizeText(rawContent)

  // 如果规范化后有差异，写回磁盘（统一换行符）
  if (content !== rawContent) {
    fs.writeFileSync(chapterFile, content, 'utf8')
  }

  const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex')

  // ── 统计字数 ────────────────────────────────────────────
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

  const chars = countChars(content)

  // ── 写入专用 preimage（短期恢复源）────────────────────────
  const preimagePath = path.join(chaptersDir, `.preimage-${chapterNum}.md`)
  fs.writeFileSync(preimagePath, content, 'utf8')
  const preimageHash = hash

  // ── 归档当前版本 ────────────────────────────────────────
  const childEnv = { ...process.env, NOVEL_WRITER_LOCK_HELD: path.resolve(projectDir) }
  let archivedPath = null

  try {
    archivedPath = execFileSync(process.execPath, [
      path.join(__dirname, 'archive.js'), chapterFile, 'pre-edit', chaptersDir
    ], { encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    // 归档失败不阻断流程，但记录警告
    result.warnings = result.warnings || []
    result.warnings.push(`归档旧版本失败: ${(e.stderr || e.message).slice(0, 200)}`)
  }

  // ── 创建编辑标记 ────────────────────────────────────────
  const useDocx = isRichTextEditor(editorCmd)
  const editFormat = useDocx ? 'docx' : 'md'

  // 如果是富文本编辑器，生成 .docx 文件
  let docxPath = null
  if (useDocx) {
    const { mdToDocx } = require('./docx-utils')
    // docx 文件放在章节同目录，命名为 原文件名.edit.docx
    docxPath = chapterFile.replace(/\.md$/, '.edit.docx')
    try {
      mdToDocx(content, docxPath)
    } catch (e) {
      result.error = `生成 docx 失败: ${e.message}`
      releaseLock()
      console.log(JSON.stringify(result, null, 2))
      process.exit(3)
    }
  }

  const marker = {
    marker_version: 2,
    chapter_num: chapterNum,
    chapter_file: path.basename(chapterFile),
    original_hash: hash,
    original_chars: chars,
    archived_path: archivedPath,
    preimage_path: preimagePath,
    preimage_hash: preimageHash,
    edit_format: editFormat,
    docx_path: docxPath ? path.basename(docxPath) : null,
    timestamp: new Date().toISOString()
  }

  const markerPath = path.join(chaptersDir, `.edit-marker-${chapterNum}.json`)
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8')

  // ── 成功 ────────────────────────────────────────────────
  const openPath = useDocx ? docxPath : chapterFile

  result.ok = true
  result.chapter_file = path.basename(chapterFile)
  result.chapter_path = chapterFile
  result.open_path = openPath
  result.marker_path = markerPath
  result.archived = archivedPath
  result.preimage_path = preimagePath
  result.chars = chars
  result.edit_format = editFormat
} catch (e) {
  result.error = e.message
} finally {
  releaseLock()
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(2)
