#!/usr/bin/env node
/**
 * search-context.js — 轻量级项目语义搜索
 *
 * 用法：node search-context.js <项目目录> <查询关键词> [返回条数=5]
 *
 * 对项目下所有结构化文件按 BM25 词频相关度排序，返回最相关的 N 个片段。
 * 每次全量读取文件并即时分词，避免缓存 tf 字典导致 OOM。
 */
const fs = require('fs')
const path = require('path')

// ── 参数 ─────────────────────────────────────────────────
const projectDir = process.argv[2]
const query = process.argv[3]
const rawTopK = Number(process.argv[4])
const topK = Number.isFinite(rawTopK)
  ? Math.min(50, Math.max(1, rawTopK))
  : 5

if (!projectDir || !query) {
  console.error('用法: node search-context.js <项目目录> <查询关键词> [返回条数=5]')
  process.exit(1)
}
if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  console.error(`ERROR: 项目目录不存在: ${projectDir}`)
  process.exit(1)
}

function normalizeForSearch(text) {
  return text
    .toLowerCase()
    .replace(/[#*_`|>~\[\](){}"'“”‘’.,，。！？；：、<>《》【】（）()\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── 分词 ─────────────────────────────────────────────────
function tokenize(text) {
  const clean = normalizeForSearch(text)
  const tokens = []
  const cjkRuns = clean.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || []
  for (const run of cjkRuns) {
    tokens.push(run)
    for (let i = 0; i < run.length - 1; i++) tokens.push(run[i] + run[i + 1])
    for (const ch of run) tokens.push(ch)
  }
  const alphaRuns = clean.match(/[a-zA-Z0-9]+/g) || []
  for (const w of alphaRuns) tokens.push(w.toLowerCase())
  return tokens
}

function getCjkBigrams(text) {
  const normalized = normalizeForSearch(text).replace(/\s+/g, '')
  const runs = normalized.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || []
  const bigrams = []
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) bigrams.push(run.slice(i, i + 2))
  }
  return [...new Set(bigrams)]
}

function getEvidenceTokens(text) {
  const normalized = normalizeForSearch(text)
  const ascii = normalized.match(/[a-z0-9]{3,}/g) || []
  const cjkRuns = normalized.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) || []
  const cjkBigrams = getCjkBigrams(normalized)
  return [...new Set([...ascii, ...cjkRuns, ...cjkBigrams])]
}

function countTokenOverlap(query, candidateText) {
  const q = getEvidenceTokens(query)
  if (!q.length) return 0
  const hay = new Set(getEvidenceTokens(candidateText))
  let hits = 0
  for (const token of q) {
    if (hay.has(token)) hits++
  }
  return hits
}

function isShortChineseEntityQuery(text) {
  if (/\s/.test(text.trim())) return false
  const normalized = normalizeForSearch(text).replace(/\s+/g, '')
  return /^[\u4e00-\u9fff\u3400-\u4dbf]{2,4}$/.test(normalized)
}

function directRecallScore(query, item) {
  if (!isShortChineseEntityQuery(query)) return 0
  const normalizedQuery = normalizeForSearch(query).replace(/\s+/g, '')
  const heading = normalizeForSearch(item.heading || '').replace(/\s+/g, '')
  const body = normalizeForSearch(item.searchableText || '').replace(/\s+/g, '')
  if (!normalizedQuery) return 0
  if (heading.includes(normalizedQuery)) return 1.2
  if (body.includes(normalizedQuery)) return 0.9
  return 0
}

function entityDensityScore(normalizedQuery, seg) {
  const heading = normalizeForSearch(seg.heading || '').replace(/\s+/g, '')
  const body = normalizeForSearch(seg.searchableText || '').replace(/\s+/g, '')

  if (!normalizedQuery) return 0

  const bodyCount = body.split(normalizedQuery).length - 1
  if (heading.includes(normalizedQuery)) {
    return 10 + bodyCount * 0.1
  }
  if (bodyCount === 0) return 0

  const density = bodyCount / Math.max(body.length / 100, 1)
  return density * 2 + bodyCount * 0.3
}

function shortChineseEntitySearch(query, allSegments, topK) {
  const normalizedQuery = normalizeForSearch(query).replace(/\s+/g, '')
  const hits = allSegments
    .map(seg => ({
      file: seg.file,
      heading: seg.heading,
      line: seg.line,
      score: entityDensityScore(normalizedQuery, seg),
      excerpt: seg.excerpt,
      searchableText: seg.searchableText,
    }))
    .filter(seg => seg.score > 0)

  hits.sort((a, b) => b.score - a.score || a.line - b.line)
  return dedupeAndFilterResults(query, hits, topK, { bypassThreshold: true })
}

function normalizeExcerpt(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[^\u4e00-\u9fffa-z0-9 ]/g, '').trim()
}

function dedupeAndFilterResults(query, scored, topK, opts = {}) {
  const normalizedQuery = normalizeForSearch(query)
  const compactQuery = normalizedQuery.replace(/\s+/g, '')
  const qTokens = getEvidenceTokens(query)
  const hasEvidenceQuery = qTokens.length > 0
  const threshold = hasEvidenceQuery ? 0.25 : 0.8
  const bypassThreshold = opts.bypassThreshold === true
  const maxPerFile = 2
  const keptByFile = new Map()
  const seenFingerprints = new Set()
  const filtered = []

  for (const item of scored) {
    if (item.score <= 0) continue
    if (!bypassThreshold && item.score < threshold) continue

    if (hasEvidenceQuery) {
      const searchable = [item.file, item.heading || '', item.excerpt || '', item.searchableText || ''].join(' ')
      const overlap = countTokenOverlap(query, searchable)
      const normalizedSearchable = normalizeForSearch(searchable).replace(/\s+/g, '')
      const directRecallHit = item.directRecallBonus > 0
      if (overlap === 0 && !item.exactQueryHit && !normalizedSearchable.includes(compactQuery) && !directRecallHit) continue
    }

    const fingerprint = normalizeExcerpt(item.excerpt || item.heading || '')
    if (fingerprint && seenFingerprints.has(fingerprint)) continue

    const fileCount = keptByFile.get(item.file) || 0
    if (fileCount >= maxPerFile) continue

    if (fingerprint) seenFingerprints.add(fingerprint)
    keptByFile.set(item.file, fileCount + 1)
    filtered.push(item)
    if (filtered.length >= topK) break
  }

  return filtered
}

// ── 分段器 ────────────────────────────────────────────────
function splitSegments(content, fileName, category) {
  const segments = []
  if (category === 'chapter') {
    const paragraphs = content.split(/\n{2,}/)
    let buf = '', startLine = 1, lineCount = 0
    for (const para of paragraphs) {
      const paraLines = para.split('\n').length
      if (buf.length + para.length < 500) {
        buf += (buf ? '\n\n' : '') + para
        lineCount += paraLines
      } else {
        if (buf) { segments.push({ text: buf, file: fileName, line: startLine }); startLine += lineCount }
        buf = para; lineCount = paraLines
      }
    }
    if (buf) segments.push({ text: buf, file: fileName, line: startLine })
  } else {
    const lines = content.split('\n')
    let buf = '', heading = fileName, startLine = 1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^#{1,4}\s/.test(line) && buf.trim()) {
        segments.push({ text: buf, file: fileName, heading, line: startLine })
        buf = ''; heading = line.replace(/^#+\s*/, '').trim(); startLine = i + 1
      }
      buf += (buf ? '\n' : '') + line
    }
    if (buf.trim()) segments.push({ text: buf, file: fileName, heading, line: startLine })
  }
  return segments
}

// ── 文件收集 ──────────────────────────────────────────────
function collectFiles(dir) {
  const results = []
  for (const name of ['chapter-log.md', 'foreshadowing.md', 'timeline.md', 'relationships.md']) {
    const p = path.join(dir, name)
    if (fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink()) results.push({ path: p, category: 'meta', name })
  }
  for (const sub of ['outline', 'characters', 'worldbuilding']) {
    const subDir = path.join(dir, sub)
    if (!fs.existsSync(subDir) || !fs.statSync(subDir).isDirectory()) continue
    for (const name of fs.readdirSync(subDir)) {
      if (!name.endsWith('.md')) continue
      const p = path.join(subDir, name)
      if (fs.lstatSync(p).isSymbolicLink()) continue
      results.push({ path: p, category: sub, name })
    }
  }
  const chapDir = path.join(dir, 'chapters')
  if (fs.existsSync(chapDir) && fs.statSync(chapDir).isDirectory()) {
    for (const name of fs.readdirSync(chapDir)) {
      if (!/^第\d+章(-.+)?\.md$/.test(name)) continue
      if (/\.(bak|bak2|rewrite-bak|rewrite-bak-2|para-bak)\.md$/.test(name)) continue
      const p = path.join(chapDir, name)
      if (fs.lstatSync(p).isSymbolicLink()) continue
      results.push({ path: p, category: 'chapter', name })
    }
  }
  return results
}

// ── BM25 ─────────────────────────────────────────────────
function bm25Score(queryTokens, segTf, segLen, idf, avgDl) {
  const k1 = 1.2, b = 0.75
  let score = 0
  for (const qt of queryTokens) {
    const f = segTf.get(qt) || 0
    if (f === 0) continue
    const idfVal = idf.get(qt) || 0
    score += idfVal * (f * (k1 + 1)) / (f + k1 * (1 - b + b * segLen / avgDl))
  }
  return score
}

// ── 资源预算 ──────────────────────────────────────────────
const MAX_FILE_BYTES = 1 * 1024 * 1024    // 单文件最大 1MB
const MAX_TOTAL_BYTES = 20 * 1024 * 1024  // 总扫描最大 20MB
const MAX_SEGMENTS = 2000                  // 最大段落数

// ── 主流程 ────────────────────────────────────────────────
const files = collectFiles(projectDir)
if (!files.length) { console.error('项目中未找到可搜索文件'); process.exit(0) }

const allSegments = []
let totalBytes = 0
const warnings = []

for (const f of files) {
  try {
    const stat = fs.statSync(f.path)
    if (stat.size > MAX_FILE_BYTES) {
      warnings.push(`跳过大文件 ${f.name} (${(stat.size / 1024 / 1024).toFixed(1)}MB > 1MB)`)
      continue
    }
    if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
      warnings.push(`总扫描量达到 ${(MAX_TOTAL_BYTES / 1024 / 1024).toFixed(0)}MB 上限，跳过剩余文件`)
      break
    }
    totalBytes += stat.size

    const content = fs.readFileSync(f.path, 'utf8')
    const segs = splitSegments(content, f.name, f.category)

    for (const seg of segs) {
      if (allSegments.length >= MAX_SEGMENTS) break
      const tokens = tokenize(seg.text)
      const tf = new Map()
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)

      allSegments.push({
        file: seg.file, heading: seg.heading || null, line: seg.line,
        tf, len: tokens.length,
        excerpt: seg.text.slice(0, 300).replace(/\n/g, ' ').trim(),
        searchableText: seg.text,
      })
    }
    if (allSegments.length >= MAX_SEGMENTS) {
      warnings.push(`段落数达到 ${MAX_SEGMENTS} 上限，跳过剩余文件`)
      break
    }
  } catch (e) { /* 跳过不可读文件 */ }
}

if (!allSegments.length) { console.error('未提取到有效段落'); process.exit(0) }

if (isShortChineseEntityQuery(query)) {
  results = shortChineseEntitySearch(query, allSegments, topK)
} else {
  // 构建 IDF
  const N = allSegments.length
  const df = new Map()
  for (const seg of allSegments) {
    const seen = new Set()
    for (const [t] of seg.tf) { if (!seen.has(t)) { df.set(t, (df.get(t) || 0) + 1); seen.add(t) } }
  }
  const idf = new Map()
  for (const [t, freq] of df) idf.set(t, Math.log((N - freq + 0.5) / (freq + 0.5) + 1))

  const avgDl = allSegments.reduce((sum, s) => sum + s.len, 0) / N
  const queryTokens = tokenize(query)

  const scored = allSegments.map(seg => ({
    file: seg.file, heading: seg.heading, line: seg.line,
    score: bm25Score(queryTokens, seg.tf, seg.len, idf, avgDl),
    excerpt: seg.excerpt,
    searchableText: seg.searchableText,
    exactQueryHit: normalizeForSearch(seg.searchableText).includes(normalizeForSearch(query)),
  }))

  scored.sort((a, b) => b.score - a.score)
  results = dedupeAndFilterResults(query, scored, topK)
}

if (!results.length) {
  const out = { query, results: [], message: '未找到相关内容' }
  if (warnings.length) out.warnings = warnings
  console.log(JSON.stringify(out))
} else {
  const out = {
    query,
    results: results.map(r => ({
      file: r.file, heading: r.heading, line: r.line,
      score: Math.round(r.score * 1000) / 1000, excerpt: r.excerpt,
    })),
  }
  if (warnings.length) out.warnings = warnings
  console.log(JSON.stringify(out, null, 2))
}
