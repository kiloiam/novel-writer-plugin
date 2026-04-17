#!/usr/bin/env node
// 统计项目中现存章节数量
// 用法: node count-chapters.js <chapters_dir>
// 输出: 数字（现存章节数）

const fs = require('fs');
const path = require('path');

const chaptersDir = process.argv[2] || '.';

if (!fs.existsSync(chaptersDir) || !fs.statSync(chaptersDir).isDirectory()) {
  process.stdout.write('0\n');
  process.exit(0);
}

const chapterPattern = /^第(\d+)章(?:-.*)?\.md$/;
const backupPattern = /\.(?:bak\.md|bak2\.md|rewrite-bak\.md|rewrite-bak-2\.md|para-bak\.md)$/;

let count = 0;
const entries = fs.readdirSync(chaptersDir);
for (const name of entries) {
  if (!chapterPattern.test(name)) continue;
  if (backupPattern.test(name)) continue;
  const fullPath = path.join(chaptersDir, name);
  // 先检查 symlink（lstat 不跟随链接），再检查 isFile（stat 跟随链接，broken symlink 会抛异常）
  try { if (fs.lstatSync(fullPath).isSymbolicLink()) continue; } catch (_) { continue; }
  if (!fs.statSync(fullPath).isFile()) continue;
  count++;
}

process.stdout.write(count + '\n');
