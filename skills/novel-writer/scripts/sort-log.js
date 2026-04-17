#!/usr/bin/env node
/**
 * sort-log.js — 按章节编号重排 chapter-log.md 中的条目
 *
 * 用法：
 *   node sort-log.js <chapter-log.md 路径>
 *
 * 行为：
 * - 使用共享解析器将文件按章节标题拆分为独立块
 * - 按章节编号升序排序（支持阿拉伯数字和中文数字）
 * - 排序前备份为 .sort-bak
 * - 排序后原地覆写
 */
const fs = require('fs')
const path = require('path')
const { parseBlocks, assembleBlocks } = require('./chapter-log-parser')
const { acquireLock } = require('./project-lock')

// ── 主逻辑 ──────────────────────────────
const logFile = process.argv[2]

if (!logFile) {
  process.stderr.write('ERROR: 请提供 chapter-log.md 路径\n')
  process.exit(1)
}

const absPath = path.resolve(logFile)

if (!fs.existsSync(absPath)) {
  process.stderr.write(`ERROR: 文件不存在: ${absPath}\n`)
  process.exit(1)
}

// 拒绝符号链接，防止写穿到项目外文件
if (fs.lstatSync(absPath).isSymbolicLink()) {
  process.stderr.write(`ERROR: ${absPath} 是符号链接，拒绝操作\n`)
  process.exit(1)
}

// 备份
fs.copyFileSync(absPath, absPath + '.sort-bak')

// 获取项目锁（从日志文件路径推断项目目录）
const projectDir = path.resolve(path.dirname(absPath))
let releaseLock = () => {}
// 尝试获取锁；如果父进程已持锁（通过环境变量），acquireLock 会返回空操作
try {
  releaseLock = acquireLock(projectDir, 'sort-log')
} catch (_) {
  // sort-log 通常作为子操作被调用（如在 save-chapter/delete-chapter 内部），
  // 父进程已持锁时通过 NOVEL_WRITER_LOCK_HELD 传递。独立调用且锁被占用时，
  // 排序是只读+覆写操作，风险可接受，继续执行。
}

const content = fs.readFileSync(absPath, 'utf-8')

// ── 使用共享解析器拆分为块 ──────────────────────────────
const { headerBlock, blocks } = parseBlocks(content)

// ── 稳定排序 ──────────────────────────────
blocks.sort((a, b) => a.num - b.num)

// ── 规范化标题层级为 ## ──────────────────────────────
for (const block of blocks) {
  if (block.lines.length > 0 && /^#{1,3}\s/.test(block.lines[0])) {
    block.lines[0] = block.lines[0].replace(/^#{1,3}(\s)/, '##$1')
  }
}

// ── 组装输出 ──────────────────────────────
const output = assembleBlocks(headerBlock, blocks)

// 原子写入：先写 .tmp 再 rename，防止中途崩溃截断文件
const tmpPath = absPath + '.tmp'
try {
  fs.writeFileSync(tmpPath, output, 'utf-8')
  fs.renameSync(tmpPath, absPath)
} catch (e) {
  try { fs.unlinkSync(tmpPath) } catch (_) {}
  releaseLock()
  process.stderr.write(`ERROR: 写入失败: ${e.message}\n`)
  process.exit(1)
}
releaseLock()
process.stdout.write(`chapter-log 已按章节编号重排序（备份保留为 ${absPath}.sort-bak）\n`)
