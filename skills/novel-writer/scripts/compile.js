#!/usr/bin/env node
// 整合全书章节：将所有正文按顺序拼接为一个完整的发布版 Markdown
// 整合正式章节：第[数字]章-标题.md 和裸文件 第[数字]章.md

const fs = require('fs');
const path = require('path');
const { acquireLock } = require('./project-lock');
const { normalizeText } = require('./text-utils');

const projectDir = process.argv[2] || '.';
const chaptersDir = path.join(projectDir, 'chapters');
const outputFile = path.join(projectDir, '发布版.md');

if (!fs.existsSync(chaptersDir) || !fs.statSync(chaptersDir).isDirectory()) {
  process.stderr.write(`ERROR: 章节目录不存在: ${chaptersDir}\n`);
  process.exit(1);
}

// 获取项目锁，防止与 renumber/delete/import 并发导致数据真空
let releaseLock;
try {
  releaseLock = acquireLock(projectDir, 'compile');
} catch (e) {
  process.stderr.write(`ERROR: ${e.message}\n`);
  process.exit(5);
}

process.stdout.write(`开始整合章节: ${outputFile}\n`);

// 拒绝符号链接，防止写穿到项目外文件
if (fs.existsSync(outputFile) && fs.lstatSync(outputFile).isSymbolicLink()) {
  process.stderr.write(`ERROR: ${outputFile} 是符号链接，拒绝操作\n`);
  releaseLock();
  process.exit(1);
}

const separator = '<!-- CHAPTERS_START -->';

if (!fs.existsSync(outputFile) || !fs.statSync(outputFile).isFile()) {
  process.stderr.write(`ERROR: 发布版文件不存在，请先生成包含 ${separator} 的元信息头。\n`);
  process.exit(3);
}

const fileContent = fs.readFileSync(outputFile, 'utf-8');
const lines = fileContent.split('\n');

// Find the separator line — strict match (exact line content)
// Prevents false matches if chapter content happens to contain the separator string
let sepIndex = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === separator) {
    sepIndex = i;
    break;
  }
}

if (sepIndex === -1) {
  // 自动补充分隔符：将当前内容视为元信息头，在末尾追加分隔符
  process.stderr.write(`WARNING: 发布版缺少 ${separator} 分隔符，已自动追加。\n`);
  lines.push(separator);
  sepIndex = lines.length - 1;
}

// Back up old body content (everything after separator line)
if (sepIndex < lines.length - 1) {
  const bodyContent = lines.slice(sepIndex + 1).join('\n');
  fs.writeFileSync(outputFile + '.prev-body', bodyContent, 'utf-8');
  process.stderr.write(`已备份旧正文到 ${outputFile}.prev-body\n`);
}

// Collect chapter files
const chapterPattern = /^第(\d+)章(?:-.*)?\.md$/;
const backupPattern = /\.(?:bak\.md|bak2\.md|rewrite-bak\.md|rewrite-bak-2\.md|para-bak\.md)$/;

const chapters = [];
const entries = fs.readdirSync(chaptersDir);
for (const name of entries) {
  const match = chapterPattern.exec(name);
  if (!match) continue;
  if (backupPattern.test(name)) continue;
  const fullPath = path.join(chaptersDir, name);
  // 先检查 symlink（lstat 不跟随链接，不会因 broken symlink 崩溃）
  try {
    if (fs.lstatSync(fullPath).isSymbolicLink()) continue;
  } catch (_) { continue; }
  if (!fs.statSync(fullPath).isFile()) continue;

  let num = parseInt(match[1], 10);
  if (isNaN(num)) num = 0;
  chapters.push({ num, name, fullPath });
}

// Sort by chapter number ascending
chapters.sort((a, b) => a.num - b.num);

// 原子写入：先写 .tmp，全部完成后 rename，避免中途崩溃截断目标文件
const tmpFile = outputFile + '.tmp';
try {
  const headerContent = lines.slice(0, sepIndex + 1).join('\n') + '\n';
  fs.writeFileSync(tmpFile, headerContent, 'utf-8');

  // Append each chapter's content to tmp file
  for (const ch of chapters) {
    process.stdout.write(`合并: ${ch.name}\n`);
    const content = normalizeText(fs.readFileSync(ch.fullPath, 'utf-8'));
    fs.appendFileSync(tmpFile, content + '\n\n', 'utf-8');
  }

  // Atomic rename: only replace target after all writes succeed
  fs.renameSync(tmpFile, outputFile);
} catch (e) {
  // ENOSPC 等写入失败时清理残留 .tmp，避免雪上加霜
  try { fs.unlinkSync(tmpFile) } catch (_) {}
  releaseLock();
  process.stderr.write(`ERROR: 编译失败: ${e.message}\n`);
  process.exit(1);
}

releaseLock();
process.stdout.write('整合完成！\n');
