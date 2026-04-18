#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const chaptersDir = process.argv[2] || '.'
if (!fs.existsSync(chaptersDir) || !fs.statSync(chaptersDir).isDirectory()) {
  console.error(`ERROR: 目录不存在: ${chaptersDir}`)
  process.exit(1)
}

// ── 项目级互斥锁 ─────────────────────────────────────────
// chaptersDir 通常是 <projectDir>/chapters，项目锁放在 projectDir
const projectDir = path.dirname(chaptersDir)
const { acquireLock, buildUniqueTempPath } = require('./project-lock')
let releaseLock
try {
  releaseLock = acquireLock(projectDir, 'renumber')
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  process.exit(5)
}

const recoveryMap = path.join(chaptersDir, `__renumber_map_${process.pid}__.json`)

function listChapterFiles(dir) {
  const files = []
  for (const name of fs.readdirSync(dir)) {
    // Normal chapters: 第X章-标题.md or 第X章.md (bare, no title)
    if (/^第\d+章(-.+)?\.md$/.test(name) && !/\.(bak|bak2|rewrite-bak|rewrite-bak-2|para-bak)\.md$/.test(name)) {
      const fp = path.join(dir, name)
      try { if (fs.lstatSync(fp).isSymbolicLink()) continue } catch (_) { continue }
      files.push({
        name,
        path: fp,
        num: Number((name.match(/^第(\d+)章/) || [,'0'])[1]),
        restoreRank: 1,
      })
    }
    // Restore-slot files: .__restore__第X章-标题.md or .__restore__第X章.md
    if (/^\.__restore__第\d+章(-.+)?\.md$/.test(name)) {
      const fp2 = path.join(dir, name)
      try { if (fs.lstatSync(fp2).isSymbolicLink()) continue } catch (_) { continue }
      files.push({
        name,
        path: fp2,
        num: Number((name.match(/^\.__restore__第(\d+)章/) || [,'0'])[1]),
        restoreRank: 0,  // priority: restore files come first at same number
        isRestore: true,
      })
    }
  }
  return files
}

// ── 崩溃恢复 ──────────────────────────────────────────────
// recovery map 包含 { origName, tempName, newName } 三元组
// 恢复策略：两阶段回滚
//   Phase 1: 已经变成 newName 的文件 → 退回 tempName
//   Phase 2: 所有 tempName → 退回 origName
const hasTemp = fs.readdirSync(chaptersDir).some(name => /^__temp_renumber_\d+__\.md(?:\.\d+\.[a-z0-9]+)?$/.test(name))
// 检测任意 PID 的残留恢复映射
const existingMaps = fs.readdirSync(chaptersDir).filter(name => /^__renumber_map_\d+__\.json$/.test(name))
const existingMapPath = existingMaps.length ? path.join(chaptersDir, existingMaps[0]) : null
if (hasTemp || existingMapPath) {
  if (!existingMapPath) {
    console.error('ERROR: 发现临时文件但缺少映射文件，无法自动恢复。')
    process.exit(2)
  }
  const mappings = JSON.parse(fs.readFileSync(existingMapPath, 'utf8'))
  console.error('WARNING: 检测到上次重编号未完成，正在两阶段恢复...')

  // Phase 1: newName → tempName (回滚已完成的最终重命名)
  for (const { tempName, newName } of mappings) {
    if (!newName) continue  // 映射表可能尚未填入 newName（崩溃发生在计算阶段之前）
    if (fs.existsSync(newName) && !fs.existsSync(tempName)) {
      fs.renameSync(newName, tempName)
      console.error(`  回滚: ${path.basename(newName)} → ${path.basename(tempName)}`)
    }
  }

  // Phase 2: tempName → origName (回滚到初始状态)
  for (const { tempName, origName } of mappings) {
    if (!fs.existsSync(tempName)) continue
    if (fs.existsSync(origName)) {
      console.error(`ERROR: 恢复目标已存在，拒绝覆盖: ${origName}`)
      console.error('请先手动处理冲突后再重试。')
      process.exit(3)
    }
    fs.renameSync(tempName, origName)
    console.error(`  恢复: ${path.basename(origName)}`)
  }

  fs.unlinkSync(existingMapPath)
  console.error('恢复完成，重新开始重编号')
}

// ── 正式重编号 ────────────────────────────────────────────
const files = listChapterFiles(chaptersDir).sort((a, b) => a.num - b.num || a.restoreRank - b.restoreRank || a.name.localeCompare(b.name, 'zh-CN'))
const n = files.length
const width = String(Math.max(999, n)).length

// Step 1: 预先计算所有 newName，一次性写入 recovery map
const mappings = []
let zeroSeen = false
let nextNum = 1

for (let i = 0; i < files.length; i++) {
  const oldName = files[i].name
  let title = oldName.replace(/^\.__restore__/, '').replace(/^第\d+章-?/, '').replace('--restore-slot--', '')
  // Strip batch index prefix from multi-insert: "000--title.md" → "title.md"
  title = title.replace(/^\d{3}--/, '')
  // Bare files like 第3章.md leave only '.md' after stripping — use fallback title
  if (!title || title === '.md') title = '无题.md'
  let newNum
  if (files[i].num === 0 && !zeroSeen) {
    newNum = 0
    zeroSeen = true
  } else {
    newNum = nextNum++
  }
  const padded = String(newNum).padStart(width, '0')
  const newName = `第${padded}章-${title}`
  const tempPath = buildUniqueTempPath(path.join(chaptersDir, `__temp_renumber_${i}__`), '.md')
  const newPath = path.join(chaptersDir, newName)
  mappings.push({
    origName: files[i].path,
    tempName: tempPath,
    newName: newPath,
    oldDisplayName: oldName,
    newDisplayName: newName,
  })
}

// 原子写入：先写 .tmp 再 rename，防止断电截断导致 JSON 损坏
const tmpMap = buildUniqueTempPath(recoveryMap)
fs.writeFileSync(tmpMap, JSON.stringify(mappings, null, 2), 'utf8')
fs.renameSync(tmpMap, recoveryMap)

// Step 2: 全部重命名为 temp
for (const m of mappings) {
  fs.renameSync(m.origName, m.tempName)
}

// Step 3: 从 temp 重命名为 newName
let changes = 0
for (const m of mappings) {
  if (fs.existsSync(m.newName)) {
    console.error(`ERROR: 目标文件已存在，停止重编号: ${m.newName}`)
    process.exit(4)
  }
  fs.renameSync(m.tempName, m.newName)
  if (m.oldDisplayName !== m.newDisplayName) {
    console.log(`${m.oldDisplayName} → ${m.newDisplayName}`)
    changes++
  }
}

// Step 4: 清理 recovery map
fs.unlinkSync(recoveryMap)
if (changes === 0) {
  console.error('无需重编号')
}
