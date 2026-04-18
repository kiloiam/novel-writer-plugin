#!/usr/bin/env node
/**
 * rollback-snapshot.js — 从删除前快照回滚整个项目状态
 *
 * 用法：
 *   node rollback-snapshot.js <项目目录> <快照目录> [--mode exact|repack]
 *
 * 模式：
 *   exact  — 精确恢复：按快照原样覆盖，不做重编号或额外修复
 *   repack — 重整恢复（默认）：覆盖后重编号，确保章节编号连续
 *
 * 行为：
 * - 读取快照目录中的 manifest.json
 * - 逐文件用快照内容覆盖当前项目文件
 * - 回滚完成后不自动删除快照（保留供审查）
 *
 * 输出 JSON：
 *   { ok, mode, restored_files, warnings }
 */
const fs = require('fs')
const path = require('path')
const { acquireLock, buildInheritedLockEnvFromProject } = require('./project-lock')

const projectDir = process.argv[2]
const snapshotDir = process.argv[3]

if (!projectDir || !snapshotDir) {
  console.error('用法: node rollback-snapshot.js <项目目录> <快照目录> [--mode exact|repack]')
  process.exit(1)
}

// 解析 --mode
let mode = 'repack'
for (let i = 4; i < process.argv.length; i++) {
  if (process.argv[i] === '--mode' && process.argv[i + 1]) {
    mode = process.argv[++i]
  }
}
if (mode !== 'exact' && mode !== 'repack') {
  console.error(`ERROR: 无效模式 "${mode}"，允许 exact 或 repack`)
  process.exit(1)
}

if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  console.error(`ERROR: 项目目录不存在: ${projectDir}`)
  process.exit(1)
}

if (!fs.existsSync(snapshotDir) || !fs.statSync(snapshotDir).isDirectory()) {
  console.error(`ERROR: 快照目录不存在: ${snapshotDir}`)
  process.exit(1)
}

const manifestPath = path.join(snapshotDir, 'manifest.json')
if (!fs.existsSync(manifestPath)) {
  console.error(`ERROR: 快照清单不存在: ${manifestPath}`)
  process.exit(1)
}

// 获取锁
let releaseLock
try {
  releaseLock = acquireLock(projectDir, 'rollback-snapshot')
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  process.exit(5)
}

const result = { ok: false, mode, restored_files: [], warnings: [] }

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  // 防御性校验
  if (!Array.isArray(manifest.files)) {
    throw new Error('manifest.json 格式无效: files 不是数组')
  }

  const resolvedProject = path.resolve(projectDir)

  for (const rel of manifest.files) {
    const src = path.join(snapshotDir, rel)
    const dest = path.resolve(projectDir, rel)

    // 路径穿越防御：确保目标路径在项目目录内
    if (!dest.startsWith(resolvedProject + path.sep) && dest !== resolvedProject) {
      result.warnings.push(`路径穿越拒绝: ${rel}`)
      continue
    }

    if (!fs.existsSync(src)) {
      result.warnings.push(`快照文件缺失，已跳过: ${rel}`)
      continue
    }

    // 拒绝 symlink
    if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) {
      fs.unlinkSync(dest)
      result.warnings.push(`${rel} 是符号链接，已删除并替换`)
    }

    // 确保目标目录存在
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    result.restored_files.push(rel)
  }

  // 两种模式都需要：删除 chapters/ 中不在快照中的多余章节文件
  // exact: 确保文件集合与快照时刻完全一致
  // repack: 先清理残留文件（如删除后重编号产生的），再重编号，避免重复章节
  const chaptersDir = path.join(projectDir, 'chapters')
  if (fs.existsSync(chaptersDir)) {
    const snapshotChapterFiles = new Set(
      manifest.files
        .filter(f => f.replace(/\\/g, '/').startsWith('chapters/'))
        .map(f => path.basename(f))
    )
    for (const name of fs.readdirSync(chaptersDir)) {
      if (!/^第\d+章(-.+)?\.md$/.test(name)) continue
      if (snapshotChapterFiles.has(name)) continue
      const extraFile = path.join(chaptersDir, name)
      if (fs.lstatSync(extraFile).isSymbolicLink() || !fs.statSync(extraFile).isFile()) continue
      try {
        fs.unlinkSync(extraFile)
        result.warnings.push(`删除快照外的多余文件 ${name}`)
      } catch (_) {
        result.warnings.push(`无法删除多余文件 ${name}`)
      }
    }
  }

  // repack 模式：重编号确保章节编号连续
  if (mode === 'repack') {
    if (fs.existsSync(chaptersDir)) {
      const { execFileSync } = require('child_process')
      const childEnv = buildInheritedLockEnvFromProject(projectDir, process.env)
      try {
        execFileSync(process.execPath, [path.join(__dirname, 'renumber.js'), chaptersDir], {
          encoding: 'utf8', env: childEnv, stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (_) {
        result.warnings.push('重编号失败（非致命）')
      }
    }
  }

  // 清理中间产物（sort-bak 等临时备份文件）
  const cleanupPatterns = ['.sort-bak']
  for (const suffix of cleanupPatterns) {
    for (const rel of manifest.files) {
      const candidate = path.join(projectDir, rel) + suffix
      try { if (fs.existsSync(candidate)) fs.unlinkSync(candidate) } catch (_) {}
    }
  }

  // 清理操作日志（回滚成功后必须清除，否则后续操作会被永久拦截）
  const journalPath = path.join(projectDir, 'chapters', '.__op_journal__.json')
  try {
    if (fs.existsSync(journalPath)) {
      fs.unlinkSync(journalPath)
      result.warnings.push('已清除残留操作日志')
    }
  } catch (_) {
    result.warnings.push('警告：操作日志清除失败，请手动删除: ' + journalPath)
  }

  result.ok = true
} catch (e) {
  result.error = e.message
} finally {
  releaseLock()
}

console.log(JSON.stringify(result, null, 2))
