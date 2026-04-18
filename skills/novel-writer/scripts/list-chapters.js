#!/usr/bin/env node
// 列出项目中现存章节（编号、文件名、字数）
// 处理标准章节：第[数字]章-标题.md 和裸文件 第[数字]章.md

const fs = require('fs');
const path = require('path');

const inputDir = process.argv[2] || '.';
const chaptersDir = fs.existsSync(path.join(inputDir, 'chapters')) && fs.statSync(path.join(inputDir, 'chapters')).isDirectory()
  ? path.join(inputDir, 'chapters')
  : inputDir;

if (!fs.existsSync(chaptersDir) || !fs.statSync(chaptersDir).isDirectory()) {
  process.stdout.write('总计|0\n');
  process.exit(0);
}

const chapterPattern = /^第(\d+)章(?:-.*)?\.md$/;
const backupPattern = /\.(?:bak\.md|bak2\.md|rewrite-bak\.md|rewrite-bak-2\.md|para-bak\.md)$/;

const rows = [];
let total = 0;

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

  // Strip leading zeros from chapter number
  let num = parseInt(match[1], 10);
  if (isNaN(num)) num = 0;

  // Read file and compute character count
  const content = fs.readFileSync(fullPath, 'utf-8');
  // Strip markdown syntax to get approximate pure text character count
  const cleaned = content
    .split('\n')
    .filter(line => !(/^#/.test(line)))         // markdown headers
    .filter(line => !(/^>/.test(line)))          // blockquotes
    .filter(line => !(/^---$/.test(line)))       // horizontal rules
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // images ![alt](url)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // links [text](url) → text
    .replace(/<[^>]+>/g, '')                      // HTML tags
    .replace(/`{1,3}[^`]*`{1,3}/g, '')           // inline code
    .replace(/\*\*/g, '')                         // bold markers
    .replace(/[*_~]/g, '');                       // italic/strikethrough markers

  // Strip all whitespace, then count characters
  const stripped = cleaned.replace(/\s/g, '');
  const chars = stripped.length;

  total += chars;
  rows.push({ num, name, chars });
}

// Sort by chapter number ascending
rows.sort((a, b) => a.num - b.num);

for (const row of rows) {
  process.stdout.write(`${row.num}|${row.name}|${row.chars}\n`);
}

process.stdout.write(`总计|${total}\n`);
