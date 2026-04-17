#!/usr/bin/env node
/**
 * update-metadata.js — 元数据文件写入网关（自动快照保护）
 *
 * 用法：
 *   node update-metadata.js <项目目录> <目标文件相对路径> <新内容文件>
 *
 * 支持的目标文件：
 *   outline/*.md, characters/*.md, worldbuilding/*.md,
 *   relationships.md, timeline.md, foreshadowing.md
 *
 * 行为：
 * 1. 获取项目锁
 * 2. 写入前自动快照旧版本到 .meta_history/
 * 3. symlink 检查
 * 4. 文本规范化（CRLF→LF、去BOM）
 * 5. 写入新内容
 * 6. 更新 PROJECT.yaml last_action
 *
 * 输出 JSON：
 *   { ok, file, snapshot, old_size, new_size, warnings }
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { acquireLock } = require('./project-lock')
const { normalizeText } = require('./text-utils')

const projectDir = process.argv[2]
const relPath = process.argv[3]
const contentFile = process.argv[4]

if (!projectDir || !relPath || !contentFile) {
  console.error('用法: node update-metadata.js <项目目录> <目标文件相对路径> <新内容文件>')
  process.exit(1)
}

if (!fs.existsSync(projectDir)) { console.error(`ERROR: 项目目录不存在: ${projectDir}`); process.exit(1) }
if (!fs.existsSync(contentFile)) { console.error(`ERROR: 内容文件不存在: ${contentFile}`); process.exit(1) }

// 验证目标路径在允许范围内
const ALLOWED_PREFIXES = ['outline/', 'characters/', 'worldbuilding/']
const ALLOWED_FILES = ['relationships.md', 'timeline.md', 'foreshadowing.md']
const normalized = relPath.replace(/\\/g, '/')
const isAllowed = ALLOWED_FILES.includes(normalized) ||
  ALLOWED_PREFIXES.some(p => normalized.startsWith(p) && normalized.endsWith('.md'))

if (!isAllowed) {
  console.error(`ERROR: 不支持的目标文件: ${relPath}`)
  console.error('允许的目标: outline/*.md, characters/*.md, worldbuilding/*.md, relationships.md, timeline.md, foreshadowing.md')
  process.exit(1)
}

const targetPath = path.join(projectDir, relPath)

// 路径穿越防御：resolve 后的目标路径必须在项目目录内
const resolvedProject = path.resolve(projectDir)
const resolvedTarget = path.resolve(targetPath)
if (!resolvedTarget.startsWith(resolvedProject + path.sep) && resolvedTarget !== resolvedProject) {
  console.error(`ERROR: 路径穿越拒绝: ${relPath} 解析到项目目录外 (${resolvedTarget})`)
  process.exit(1)
}

// 获取锁
let releaseLock
try {
  releaseLock = acquireLock(projectDir, 'update-metadata')
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  process.exit(5)
}

const result = { ok: false, file: relPath, snapshot: null, old_size: 0, new_size: 0, warnings: [] }

try {
  // symlink 检查
  if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) {
    fs.unlinkSync(targetPath)
    result.warnings.push(`${relPath} 是符号链接，已删除并替换为普通文件`)
  }

  // 快照旧版本
  if (fs.existsSync(targetPath)) {
    const histDir = path.join(projectDir, '.meta_history')
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const snapshotName = normalized.replace(/\//g, '--') + '--' + ts
    const snapshotPath = path.join(histDir, snapshotName)

    try {
      fs.mkdirSync(histDir, { recursive: true })
      fs.copyFileSync(targetPath, snapshotPath)
      result.snapshot = snapshotPath
      result.old_size = fs.statSync(targetPath).size
    } catch (e) {
      result.warnings.push(`快照失败 (非致命): ${e.message}`)
    }
  }

  // 确保目标目录存在
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  // 规范化并原子写入（.tmp + rename，防断电截断）
  const newContent = normalizeText(fs.readFileSync(contentFile, 'utf8'))
  const tmpWrite = targetPath + '.tmp'
  fs.writeFileSync(tmpWrite, newContent, 'utf8')
  fs.renameSync(tmpWrite, targetPath)
  result.new_size = Buffer.byteLength(newContent, 'utf8')

  // 更新 PROJECT.yaml last_action
  const scriptDir = __dirname
  const childEnv = { ...process.env, NOVEL_WRITER_LOCK_HELD: path.resolve(projectDir) }
  try {
    execFileSync(process.execPath, [
      path.join(scriptDir, 'update-project.js'), projectDir,
      '--last-action', JSON.stringify({
        type: 'update-metadata',
        target: relPath,
        timestamp: new Date().toISOString(),
      }),
    ], { encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (_) {
    result.warnings.push('PROJECT.yaml 更新失败（非致命）')
  }

  result.ok = true
} catch (e) {
  result.error = e.message
} finally {
  releaseLock()
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(2)
