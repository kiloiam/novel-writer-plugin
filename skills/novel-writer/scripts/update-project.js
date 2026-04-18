#!/usr/bin/env node
/**
 * update-project.js — PROJECT.yaml 安全更新器
 *
 * 用法：
 *   node update-project.js <项目目录> [选项...]
 *
 * 选项（可组合）：
 *   --chapter <N>                设置 current_chapter
 *   --status <值>                设置 status (planning/writing/polishing/completed)
 *   --add-character <名>        添加到 active_characters（不重复）
 *   --remove-character <名>     从 active_characters 移除
 *   --set-characters <名1,名2>  覆盖 active_characters
 *   --add-plotline <描述>       添加到 focus_plotlines
 *   --remove-plotline <描述>    从 focus_plotlines 移除
 *   --set-plotlines <描述1,描述2> 覆盖 focus_plotlines
 *   --next-note <内容>          设置 next_chapter_note
 *   --last-action <JSON>        设置 last_action（JSON 字符串）
 *   --total <N>                 设置 total_chapters
 *
 * 输出：更新后的 PROJECT.yaml 的关键字段（JSON）
 *
 * 特点：
 * - 只修改指定字段，保留其余内容不变
 * - 自动设置 updated 为当前日期
 * - 验证字段值合法性
 * - 保证 YAML 结构完整，不会因 LLM 输出截断而丢失字段
 */
const fs = require('fs')
const path = require('path')
const { acquireLock } = require('./project-lock')

const projectDir = process.argv[2]
if (!projectDir) {
  console.error('用法: node update-project.js <项目目录> [选项...]')
  process.exit(1)
}

const yamlPath = path.join(projectDir, 'PROJECT.yaml')
if (!fs.existsSync(yamlPath)) {
  console.error(`ERROR: PROJECT.yaml 不存在: ${yamlPath}`)
  process.exit(1)
}

// ── 项目级互斥锁（NOVEL_WRITER_LOCK_HELD 时自动跳过）────
let releaseLock
try {
  releaseLock = acquireLock(projectDir, 'update-project')
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  process.exit(5)
}

// ── 极简 YAML 解析/序列化（仅处理 PROJECT.yaml 的扁平+浅层结构）──
// 已知可安全解析的字段集合；不在此集合中的字段保留原文
const KNOWN_SCALAR_KEYS = new Set([
  'title', 'genre', 'style', 'target_words', 'chapter_target_words',
  'platform', 'status', 'current_chapter', 'total_chapters', 'current_volume',
  'next_chapter_note', 'created', 'updated',
])
const KNOWN_LIST_KEYS = new Set(['active_characters', 'focus_plotlines'])
const KNOWN_NESTED_KEYS = new Set(['last_action'])

// Extract value from a YAML scalar that may have trailing inline comments.
// Handles: "quoted" # comment, 'quoted' # comment, unquoted # comment, bare value
function stripYamlScalar(raw) {
  const s = raw.trim()
  if (!s) return ''
  // Quoted: find matching closing quote, ignore everything after it
  if (s[0] === '"' || s[0] === "'") {
    const quote = s[0]
    let i = 1
    while (i < s.length) {
      if (s[i] === '\\' && quote === '"' && i + 1 < s.length) { i += 2; continue }
      if (s[i] === quote) return s.slice(1, i)
      i++
    }
    // No closing quote found — return as-is minus the opening quote
    return s.slice(1)
  }
  // Unquoted: strip inline comment (space + #)
  return s.replace(/\s+#.*$/, '')
}

// Quote-aware inline list splitter: correctly handles commas inside quotes
// Input: inner content of [...] (without brackets)
// Supports: 'a,b', "a,b", unquoted
function splitInlineList(inner) {
  const items = []
  let current = ''
  let inQuote = null // null | "'" | '"'
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue }
      current += ch
    } else if (ch === "'" || ch === '"') {
      inQuote = ch
    } else if (ch === ',') {
      const trimmed = current.trim()
      if (trimmed) items.push(trimmed)
      current = ''
    } else {
      current += ch
    }
  }
  const trimmed = current.trim()
  if (trimmed) items.push(trimmed)
  return items
}

// Parse YAML inline mapping: {key: val, key: "val with, comma", key: [a, b]}
function parseInlineMapping(str) {
  // Try JSON first (handles double-quoted keys/values)
  try {
    const parsed = JSON.parse(str)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch (_) {}

  // Manual YAML flow mapping parser
  const inner = str.slice(1, -1).trim()  // strip { }
  const result = {}
  let pos = 0

  function skipWs() { while (pos < inner.length && /\s/.test(inner[pos])) pos++ }

  function readValue() {
    skipWs()
    if (pos >= inner.length) return ''
    const ch = inner[pos]

    // Quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch
      pos++
      let val = ''
      while (pos < inner.length && inner[pos] !== quote) {
        if (inner[pos] === '\\' && pos + 1 < inner.length) { val += inner[++pos]; pos++; continue }
        val += inner[pos++]
      }
      pos++ // skip closing quote
      return val
    }

    // Inline list [...]
    if (ch === '[') {
      const start = pos
      let depth = 0
      while (pos < inner.length) {
        if (inner[pos] === '[') depth++
        else if (inner[pos] === ']') { depth--; if (depth === 0) { pos++; break } }
        else if (inner[pos] === '"' || inner[pos] === "'") {
          const q = inner[pos++]
          while (pos < inner.length && inner[pos] !== q) { if (inner[pos] === '\\') pos++; pos++ }
          pos++; continue
        }
        pos++
      }
      return splitInlineList(inner.slice(start + 1, pos - 1))
    }

    // Unquoted value: read until , or }
    let val = ''
    while (pos < inner.length && inner[pos] !== ',' && inner[pos] !== '}') {
      val += inner[pos++]
    }
    return val.trim()
  }

  while (pos < inner.length) {
    skipWs()
    if (pos >= inner.length) break

    // Read key (unquoted or quoted)
    let key = ''
    if (inner[pos] === '"' || inner[pos] === "'") {
      const quote = inner[pos++]
      while (pos < inner.length && inner[pos] !== quote) key += inner[pos++]
      pos++ // skip closing quote
    } else {
      while (pos < inner.length && inner[pos] !== ':') key += inner[pos++]
    }
    key = key.trim()

    skipWs()
    if (inner[pos] === ':') pos++ // skip :

    const val = readValue()
    if (key) result[key] = val

    skipWs()
    if (inner[pos] === ',') pos++ // skip comma
  }

  return result
}

function parseYaml(text) {
  const obj = {}
  // _rawBlocks: 保留不认识的字段的原始文本，key → raw lines（含首行）
  const rawBlocks = {}
  const lines = text.split('\n')
  let currentKey = null
  let currentList = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 跳过注释和空行
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue

    // 列表项
    const listMatch = line.match(/^\s+-\s+(.*)$/)
    if (listMatch && currentKey && currentList !== null) {
      currentList.push(stripYamlScalar(listMatch[1]))
      obj[currentKey] = currentList
      continue
    }

    // 键值对
    const kvMatch = line.match(/^(\w[\w_]*):\s*(.*)$/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      let val = kvMatch[2].trim()

      // 值为空 或 block scalar 指示符
      if (val === '' || val === '|' || val === '>' || val === '|+' || val === '|-' || val === '>+' || val === '>-') {
        // 检查下一行是否是列表项（已知列表字段）
        if (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
          if (KNOWN_LIST_KEYS.has(currentKey)) {
            currentList = []
            continue
          }
        }

        // 已知嵌套对象字段
        if (KNOWN_NESTED_KEYS.has(currentKey) && val !== '|' && val !== '>' && val !== '|+' && val !== '|-' && val !== '>+' && val !== '>-') {
          const nested = {}
          let j = i + 1
          while (j < lines.length && /^\s+\w/.test(lines[j])) {
            const nm = lines[j].match(/^\s+(\w[\w_]*):\s*(.*)$/)
            if (nm) {
              let nv = stripYamlScalar(nm[2])
              // 嵌套列表 (targets)
              if (nv === '' && j + 1 < lines.length && /^\s+-\s/.test(lines[j + 1])) {
                const nestedList = []
                j++
                while (j < lines.length && /^\s+-\s/.test(lines[j])) {
                  nestedList.push(stripYamlScalar(lines[j].match(/^\s+-\s+(.*)$/)[1]))
                  j++
                }
                nested[nm[1]] = nestedList
                continue
              }
              nested[nm[1]] = nv
            }
            j++
          }
          obj[currentKey] = nested
          currentList = null
          i = j - 1
          continue
        }

        // Block scalar（| 或 >）或不认识的多行结构 → 收集缩进行保留原文
        if (val === '|' || val === '>' || val === '|+' || val === '|-' || val === '>+' || val === '>-') {
          const blockLines = [line]
          let j = i + 1
          while (j < lines.length && (/^\s+/.test(lines[j]) || /^\s*$/.test(lines[j]))) {
            // 遇到新的顶层 key 就停
            if (/^\w[\w_]*:/.test(lines[j])) break
            blockLines.push(lines[j])
            j++
          }
          // 去掉尾部空行
          while (blockLines.length > 1 && /^\s*$/.test(blockLines[blockLines.length - 1])) blockLines.pop()

          // 如果是已知标量字段（如 next_chapter_note），解析 block scalar 值以便程序使用
          if (KNOWN_SCALAR_KEYS.has(currentKey)) {
            const indicator = val
            const contentLines = blockLines.slice(1)
            if (contentLines.length === 0) {
              obj[currentKey] = ''
            } else {
              // 计算公共缩进
              const indent = Math.min(...contentLines.filter(l => l.trim()).map(l => l.match(/^(\s*)/)[1].length))
              const stripped = contentLines.map(l => l.slice(indent))
              if (indicator.startsWith('|')) {
                obj[currentKey] = stripped.join('\n')
              } else {
                // > folded: 把单个换行变空格
                obj[currentKey] = stripped.join('\n').replace(/([^\n])\n([^\n])/g, '$1 $2')
              }
            }
          } else {
            // 不认识的字段：保留原文
            rawBlocks[currentKey] = blockLines.join('\n')
            obj[currentKey] = { __raw__: true }
          }
          currentList = null
          i = j - 1
          continue
        }

        // 空值，已知标量字段 → 空字符串
        if (KNOWN_SCALAR_KEYS.has(currentKey)) {
          obj[currentKey] = ''
          currentList = null
          continue
        }

        // 不认识的空值或多行结构 → 收集后续缩进行保留原文
        if (!KNOWN_LIST_KEYS.has(currentKey) && !KNOWN_NESTED_KEYS.has(currentKey)) {
          const blockLines = [line]
          let j = i + 1
          while (j < lines.length && /^\s+/.test(lines[j])) {
            blockLines.push(lines[j])
            j++
          }
          if (blockLines.length > 1) {
            rawBlocks[currentKey] = blockLines.join('\n')
            obj[currentKey] = { __raw__: true }
            currentList = null
            i = j - 1
            continue
          }
          // 单行空值
          obj[currentKey] = ''
          currentList = null
          continue
        }

        // 已知列表字段但下一行不是列表项 → 空列表
        if (KNOWN_LIST_KEYS.has(currentKey)) {
          obj[currentKey] = []
          currentList = null
          continue
        }

        obj[currentKey] = ''
        currentList = null
        continue
      }

      // 内联列表 [a, b, c] 或 ["a", "b"] 或 ['a,x', 'b']
      if (KNOWN_LIST_KEYS.has(currentKey) && /^\[.*\]$/.test(val)) {
        try {
          const items = JSON.parse(val)
          obj[currentKey] = Array.isArray(items) ? items.map(String) : [String(items)]
        } catch (e) {
          // JSON 解析失败（YAML 单引号等），使用 quote-aware 拆分
          obj[currentKey] = splitInlineList(val.slice(1, -1))
        }
        currentList = null
        continue
      }

      // 内联 mapping {key: val, key: val}（YAML flow mapping）
      if (KNOWN_NESTED_KEYS.has(currentKey) && /^\{.*\}$/.test(val)) {
        obj[currentKey] = parseInlineMapping(val)
        currentList = null
        continue
      }

      // 未知字段：保留原始行文本，不做任何解析/转型
      if (!KNOWN_SCALAR_KEYS.has(currentKey) && !KNOWN_LIST_KEYS.has(currentKey) && !KNOWN_NESTED_KEYS.has(currentKey)) {
        rawBlocks[currentKey] = line
        obj[currentKey] = { __raw__: true }
        currentList = null
        continue
      }

      // 去引号 + 剥离行内注释（统一处理 quoted 和 unquoted）
      val = stripYamlScalar(val)
      // 尝试数字
      if (/^\d+$/.test(val)) val = Number(val)
      obj[currentKey] = val
      currentList = null
    }
  }
  obj.__rawBlocks__ = rawBlocks
  return obj
}

function serializeYaml(obj) {
  const rawBlocks = obj.__rawBlocks__ || {}
  const lines = []
  const keyOrder = [
    'title', 'genre', 'style', 'target_words', 'chapter_target_words',
    'platform', 'status', '', // blank line
    'current_chapter', 'total_chapters', 'current_volume', '',
    'active_characters', 'focus_plotlines', 'next_chapter_note', '',
    'last_action', '',
    'created', 'updated',
  ]

  const seen = new Set(['__rawBlocks__'])
  for (const key of keyOrder) {
    if (key === '') { lines.push(''); continue }
    if (!(key in obj)) continue
    seen.add(key)
    // raw block → 原样输出
    if (rawBlocks[key]) {
      lines.push(rawBlocks[key])
    } else {
      lines.push(serializeField(key, obj[key]))
    }
  }
  // 追加未在 keyOrder 中的字段
  for (const key of Object.keys(obj)) {
    if (seen.has(key)) continue
    if (rawBlocks[key]) {
      lines.push(rawBlocks[key])
    } else {
      lines.push(serializeField(key, obj[key]))
    }
  }
  return lines.join('\n') + '\n'
}

function serializeField(key, val) {
  if (Array.isArray(val)) {
    if (val.length === 0) return `${key}:`
    return `${key}:\n` + val.map(v => `  - ${quoteIfNeeded(String(v))}`).join('\n')
  }
  if (val && typeof val === 'object') {
    // __raw__ 标记的字段不会走到这里（被 rawBlocks 拦截），但做防御
    if (val.__raw__) return `${key}: ""`
    const inner = Object.entries(val).map(([k, v]) => {
      if (Array.isArray(v)) {
        if (v.length === 0) return `  ${k}:`
        return `  ${k}:\n` + v.map(item => `    - ${quoteIfNeeded(String(item))}`).join('\n')
      }
      return `  ${k}: ${quoteIfNeeded(String(v))}`
    }).join('\n')
    return `${key}:\n${inner}`
  }
  if (val === '' || val === null || val === undefined) return `${key}: ""`
  // 多行字符串 → 使用 block scalar 格式
  const str = String(val)
  if (str.includes('\n')) {
    const indented = str.split('\n').map(l => `  ${l}`).join('\n')
    return `${key}: |\n${indented}`
  }
  return `${key}: ${quoteIfNeeded(str)}`
}

function quoteIfNeeded(s) {
  if (/[:#\[\]{}|>&*!?,]/.test(s) || /^\s/.test(s) || /\s$/.test(s)) return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return s
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function pickVerificationSnapshot(obj) {
  return {
    title: obj.title,
    genre: obj.genre,
    style: obj.style,
    target_words: obj.target_words,
    chapter_target_words: obj.chapter_target_words,
    platform: obj.platform,
    status: obj.status,
    current_chapter: obj.current_chapter,
    total_chapters: obj.total_chapters,
    current_volume: obj.current_volume,
    next_chapter_note: obj.next_chapter_note,
    active_characters: Array.isArray(obj.active_characters) ? [...obj.active_characters] : obj.active_characters,
    focus_plotlines: Array.isArray(obj.focus_plotlines) ? [...obj.focus_plotlines] : obj.focus_plotlines,
    last_action: obj.last_action && typeof obj.last_action === 'object'
      ? JSON.parse(JSON.stringify(obj.last_action))
      : obj.last_action,
    rawBlocks: obj.__rawBlocks__ || {},
  }
}

// ── 参数解析 ──────────────────────────────────────────────
const args = process.argv.slice(3)
const updates = {}

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  const next = () => { if (i + 1 >= args.length) { console.error(`ERROR: ${arg} 需要一个值`); process.exit(1) }; return args[++i] }

  switch (arg) {
    case '--chapter': {
      const v = Number(next())
      if (isNaN(v) || !Number.isInteger(v) || v < 0) { console.error('ERROR: --chapter 需要非负整数'); process.exit(1) }
      updates.current_chapter = v
      break
    }
    case '--status': {
      const s = next()
      if (!['planning', 'writing', 'polishing', 'completed'].includes(s)) {
        console.error(`ERROR: 无效 status: ${s}`)
        process.exit(1)
      }
      updates.status = s
      break
    }
    case '--add-character': {
      const name = next().trim()
      if (name) {
        updates._addChar = updates._addChar || []
        updates._addChar.push(name)
      }
      break
    }
    case '--remove-character': {
      const name = next().trim()
      if (name) {
        updates._rmChar = updates._rmChar || []
        updates._rmChar.push(name)
      }
      break
    }
    case '--set-characters': updates._setChars = next().split(',').map(s => s.trim()).filter(Boolean); break
    case '--add-plotline': {
      const plot = next().trim()
      if (plot) {
        updates._addPlot = updates._addPlot || []
        updates._addPlot.push(plot)
      }
      break
    }
    case '--remove-plotline': {
      const plot = next().trim()
      if (plot) {
        updates._rmPlot = updates._rmPlot || []
        updates._rmPlot.push(plot)
      }
      break
    }
    case '--set-plotlines': updates._setPlots = next().split(',').map(s => s.trim()).filter(Boolean); break
    case '--next-note': updates.next_chapter_note = next(); break
    case '--total': {
      const v = Number(next())
      if (isNaN(v) || !Number.isInteger(v) || v < 0) { console.error('ERROR: --total 需要非负整数'); process.exit(1) }
      updates.total_chapters = v
      break
    }
    case '--last-action': {
      try { updates.last_action = JSON.parse(next()) } catch (e) {
        console.error(`ERROR: --last-action JSON 解析失败: ${e.message}`)
        process.exit(1)
      }
      break
    }
    default:
      console.error(`ERROR: 未知选项 ${arg}`)
      process.exit(1)
  }
}

if (Object.keys(updates).length === 0) {
  console.error('ERROR: 未指定任何更新选项')
  process.exit(1)
}

// ── 读取 → 更新 → 写回 ──────────────────────────────────
const raw = fs.readFileSync(yamlPath, 'utf8')

// ── 检测 YAML anchor/alias：自定义解析器不支持，修改会静默破坏数据 ──
// 匹配值位置的 &anchor 和 *alias（排除注释行和引号内）
for (const line of raw.split('\n')) {
  if (/^\s*#/.test(line)) continue // 跳过注释
  const kvMatch = line.match(/^\w[\w_]*:\s*(.*)$/)
  if (!kvMatch) {
    // 列表项值
    const listMatch = line.match(/^\s+-\s+(.*)$/)
    if (listMatch && /[&*]\w/.test(listMatch[1])) {
      // 排除引号内的 & 和 *
      const val = listMatch[1]
      if (!/^["']/.test(val) && /(?:^|\s)[&*]\w/.test(val)) {
        console.error(`ERROR: PROJECT.yaml 包含 YAML anchor/alias 语法，本工具不支持此特性，修改会导致数据损坏。`)
        console.error(`问题行: ${line.trim()}`)
        console.error('请手动展开 anchor/alias 为普通值后重试')
        releaseLock()
        process.exit(9)
      }
    }
    continue
  }
  const val = kvMatch[1].trim()
  if (!val || /^["']/.test(val)) continue // 空值或引号开头（& * 在引号内是安全的）
  if (/(?:^|\s)[&*]\w/.test(val)) {
    console.error(`ERROR: PROJECT.yaml 包含 YAML anchor/alias 语法，本工具不支持此特性，修改会导致数据损坏。`)
    console.error(`问题行: ${line.trim()}`)
    console.error('请手动展开 anchor/alias 为普通值后重试')
    releaseLock()
    process.exit(9)
  }
}

const data = parseYaml(raw)

// 直接覆盖字段
for (const key of ['current_chapter', 'status', 'next_chapter_note', 'total_chapters', 'last_action']) {
  if (key in updates) data[key] = updates[key]
}

// active_characters 增减
if (updates._setChars) {
  data.active_characters = updates._setChars
} else {
  let chars = Array.isArray(data.active_characters) ? [...data.active_characters] : []
  if (updates._addChar) {
    // 标准化去重：忽略前后空格和大小写差异
    const normalizeChar = s => s.trim().toLowerCase()
    for (const c of updates._addChar) {
      if (!chars.some(existing => normalizeChar(existing) === normalizeChar(c))) chars.push(c.trim())
    }
  }
  if (updates._rmChar) {
    const normalizeChar = s => s.trim().toLowerCase()
    chars = chars.filter(c => !updates._rmChar.some(rm => normalizeChar(rm) === normalizeChar(c)))
  }
  if (updates._addChar || updates._rmChar) data.active_characters = chars
}

// focus_plotlines 增减
if (updates._setPlots) {
  data.focus_plotlines = updates._setPlots
} else {
  let plots = Array.isArray(data.focus_plotlines) ? [...data.focus_plotlines] : []
  if (updates._addPlot) {
    for (const p of updates._addPlot) {
      // 标准化去重：忽略冒号全半角差异和前后空格
      const normalize = s => s.replace(/\s+/g, '').replace(/[：]/g, ':')
      if (!plots.some(existing => normalize(existing) === normalize(p))) {
        plots.push(p)
      }
    }
  }
  if (updates._rmPlot) {
    const normalize = s => s.replace(/\s+/g, '').replace(/[：]/g, ':')
    plots = plots.filter(p => !updates._rmPlot.some(rm => normalize(rm) === normalize(p)))
  }
  if (updates._addPlot || updates._rmPlot) data.focus_plotlines = plots
}

// 自动更新 updated（使用本地日期，避免 UTC 时差偏移）
const now = new Date()
data.updated = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

// 写回（带校验：序列化结果必须能重新解析出关键字段，否则拒绝写入）
const output = serializeYaml(data)
try {
  const verify = parseYaml(output)
  // 校验：title 必须存在且不为空（最基本的完整性检查）
  if (!verify.title && data.title) {
    throw new Error('序列化后丢失 title 字段')
  }
  const beforeSnapshot = stableStringify(pickVerificationSnapshot(data))
  const afterSnapshot = stableStringify(pickVerificationSnapshot(verify))
  if (beforeSnapshot !== afterSnapshot) {
    throw new Error('序列化前后关键字段或原样保留块不一致')
  }
} catch (verifyErr) {
  console.error(`ERROR: YAML 序列化校验失败，拒绝写入: ${verifyErr.message}`)
  releaseLock()
  process.exit(6)
}
// 原子写入：先写 .tmp 再 rename，保留 .bak 直到成功
const tmpPath = yamlPath + '.tmp'
const bakPath = yamlPath + '.bak'
try {
  fs.writeFileSync(tmpPath, output, 'utf8')
} catch (writeErr) {
  // ENOSPC 等写入失败时清理残留 .tmp
  try { fs.unlinkSync(tmpPath) } catch (_) {}
  console.error(`ERROR: PROJECT.yaml .tmp 写入失败: ${writeErr.message}`)
  releaseLock()
  process.exit(7)
}
// 崩溃恢复：如果存在 .bak 但原文件缺失，说明上次写入中断
if (fs.existsSync(bakPath) && !fs.existsSync(yamlPath)) {
  fs.renameSync(bakPath, yamlPath)
  console.error('崩溃恢复: PROJECT.yaml.bak → PROJECT.yaml')
}
try {
  fs.renameSync(yamlPath, bakPath)
  fs.renameSync(tmpPath, yamlPath)
  try { fs.unlinkSync(bakPath) } catch (_) {}
} catch (writeErr) {
  // 恢复
  if (!fs.existsSync(yamlPath) && fs.existsSync(bakPath)) {
    fs.renameSync(bakPath, yamlPath)
  }
  try { fs.unlinkSync(tmpPath) } catch (_) {}
  console.error(`ERROR: PROJECT.yaml 写入失败: ${writeErr.message}`)
  releaseLock()
  process.exit(7)
}

releaseLock()

// 输出关键字段摘要
const summary = {
  current_chapter: data.current_chapter,
  status: data.status,
  active_characters: data.active_characters,
  focus_plotlines: data.focus_plotlines,
  last_action: data.last_action,
  updated: data.updated,
}
console.log(JSON.stringify(summary, null, 2))
