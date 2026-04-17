#!/usr/bin/env node
// 归档章节文件到 _history 或 _deleted
// 默认强保证正文快照；是否补充元数据 sidecar 由调用流程决定

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const sourceFile = args[0];
const archiveType = args[1];
let chaptersDir = args[2] || ".";
// Strip trailing slash / backslash (cross-platform)
chaptersDir = chaptersDir.replace(/[\\/]+$/, "");

// ---------------------------------------------------------------------------
// Validate source file
// ---------------------------------------------------------------------------
if (!sourceFile || !fs.existsSync(sourceFile)) {
  process.stderr.write(
    `ERROR: 源文件不存在: ${sourceFile || "(未指定)"}\n`
  );
  process.exit(1);
}

// 拒绝符号链接，防止通过 symlink 读取/归档项目外文件内容
if (fs.lstatSync(sourceFile).isSymbolicLink()) {
  process.stderr.write(
    `ERROR: 源文件是符号链接，拒绝归档以防越权读取: ${sourceFile}\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate archive type
// ---------------------------------------------------------------------------
const VALID_TYPES = [
  "polish",
  "rewrite",
  "rewrite-paragraph",
  "paragraph",
  "replace",
  "restore",
  "deleted",
  "write",
];

if (!archiveType) {
  process.stderr.write(
    "ERROR: 请指定归档类型 (polish|rewrite|rewrite-paragraph|paragraph|replace|restore|deleted|write)\n"
  );
  process.exit(1);
}

if (!VALID_TYPES.includes(archiveType)) {
  process.stderr.write(
    `ERROR: 无效的归档类型: ${archiveType}（允许值: polish|rewrite|rewrite-paragraph|paragraph|replace|restore|deleted|write）\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build timestamp  YYYYMMDD-HHMMSS (local time, matching `date +%Y%m%d-%H%M%S`)
// ---------------------------------------------------------------------------
function formatTimestamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${String(d.getMilliseconds()).padStart(3, "0")}`
  );
}

const timestamp = formatTimestamp(new Date());

// ---------------------------------------------------------------------------
// Derive basename (without .md extension)
// ---------------------------------------------------------------------------
const basenameFull = path.basename(sourceFile, ".md");

// ---------------------------------------------------------------------------
// Determine target directory
// ---------------------------------------------------------------------------
const targetDir =
  archiveType === "deleted"
    ? path.join(chaptersDir, "_deleted")
    : path.join(chaptersDir, "_history");

// ---------------------------------------------------------------------------
// Create target directory & copy file
// ---------------------------------------------------------------------------
const archiveName = `${basenameFull}--${timestamp}--${archiveType}.md`;
const targetPath = path.join(targetDir, archiveName);

try {
  fs.mkdirSync(targetDir, { recursive: true });
  // 拒绝目标路径 symlink，防止写穿到项目外文件
  if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) {
    fs.unlinkSync(targetPath);
  }
  fs.copyFileSync(sourceFile, targetPath);
} catch (err) {
  process.stderr.write(`ERROR: 归档失败: ${err.message}\n`);
  process.exit(1);
}

// Print the archive path to stdout (success)
process.stdout.write(targetPath + "\n");

// ---------------------------------------------------------------------------
// For "deleted" type: extract chapter-log entry as sidecar
// ---------------------------------------------------------------------------
if (archiveType === "deleted") {
  const { chineseToNumber, CHAPTER_HEADING_RE, ANY_HEADING_RE } = require('./chapter-log-parser');

  // Extract chapter number from filename like 第005章xxx → 5
  const chapterMatch = basenameFull.match(/^第(\d+)章/);
  let chapterNum = 0;
  if (chapterMatch) {
    chapterNum = parseInt(chapterMatch[1], 10);
    if (isNaN(chapterNum)) {
      chapterNum = 0;
    }
  }

  const logFile = path.join(chaptersDir, "..", "chapter-log.md");

  if (chapterNum > 0 && fs.existsSync(logFile)) {
    try {
      const logContent = fs.readFileSync(logFile, "utf-8");
      const lines = logContent.split(/\r?\n/);

      // Match chapter heading using shared regex (#{1,3} level)
      const headingRegex = CHAPTER_HEADING_RE;

      let found = false;
      const extracted = [];

      for (const line of lines) {
        const m = line.match(headingRegex);
        if (m) {
          const num = chineseToNumber(m[1]);
          if (num === chapterNum) {
            found = true;
          } else if (found) {
            // Hit a different chapter heading → stop
            found = false;
          }
        } else if (found && ANY_HEADING_RE.test(line)) {
          // Hit a non-chapter heading → stop
          found = false;
        }
        if (found) {
          extracted.push(line);
        }
      }

      if (extracted.length > 0) {
        const logEntryFile = path.join(
          targetDir,
          `${basenameFull}--${timestamp}--log-entry.md`
        );
        fs.writeFileSync(logEntryFile, extracted.join("\n") + "\n", "utf-8");
      }
      // If nothing extracted, no sidecar file is created (matches bash behavior)
    } catch (_) {
      // Silently ignore errors (matches bash 2>/dev/null behavior)
    }
  }
}
