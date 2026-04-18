#!/usr/bin/env node
/**
 * docx-utils.js — 纯 Node.js 零依赖 md↔docx 转换
 *
 * 提供两个核心函数：
 *   mdToDocx(mdText, outputPath)  — Markdown 纯文本 → .docx
 *   docxToMd(inputPath)           — .docx → Markdown 纯文本
 *
 * 设计约束：
 *   - 零外部依赖：不需要 pandoc/python/npm 包
 *   - 只处理小说正文场景：纯段落文本 + 标题（#/##/###）
 *   - 中文字体支持（宋体 SimSun + 微软雅黑 fallback）
 *   - ZIP 采用 STORE 方式（不压缩），简单可靠
 *   - 读取支持 STORE + DEFLATE（兼容 WPS/Word 保存的压缩 docx）
 *
 * 不处理（也不需要）：
 *   - 图片、表格、列表、加粗/斜体等富文本
 *   - 批注、修订、目录、页眉页脚
 *   - 这些在小说正文编辑场景下不会出现
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ═══════════════════════════════════════════════════════════
//  CRC-32 表（用于 ZIP 校验）
// ═══════════════════════════════════════════════════════════
const CRC32_TABLE = new Uint32Array(256)
;(function buildCRC32Table() {
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    CRC32_TABLE[i] = c >>> 0
  }
})()

function crc32(buf) {
  if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8')
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ═══════════════════════════════════════════════════════════
//  XML 转义
// ═══════════════════════════════════════════════════════════
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ═══════════════════════════════════════════════════════════
//  mdToDocx — Markdown → DOCX
// ═══════════════════════════════════════════════════════════
/**
 * @param {string} mdText  Markdown 纯文本
 * @param {string} outputPath  输出 .docx 文件路径
 */
function mdToDocx(mdText, outputPath) {
  // ── 解析 Markdown 为段落列表 ────────────────────────────
  const lines = mdText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const paragraphs = [] // { text, level } level: 0=正文, 1/2/3=标题级别

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/)
    if (headingMatch) {
      paragraphs.push({ text: headingMatch[2].trim(), level: headingMatch[1].length })
    } else if (line.trim() === '') {
      // 空行：如果上一个不是空段，加一个空段
      if (paragraphs.length === 0 || paragraphs[paragraphs.length - 1].text !== '') {
        paragraphs.push({ text: '', level: 0 })
      }
    } else {
      paragraphs.push({ text: line, level: 0 })
    }
  }

  // 去掉首尾空段
  while (paragraphs.length > 0 && paragraphs[0].text === '') paragraphs.shift()
  while (paragraphs.length > 0 && paragraphs[paragraphs.length - 1].text === '') paragraphs.pop()

  // ── 生成 document.xml 内容 ──────────────────────────────
  let bodyXml = ''
  for (const p of paragraphs) {
    if (p.text === '') {
      // 空段落
      bodyXml += '<w:p><w:pPr><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:pPr></w:p>'
    } else if (p.level > 0) {
      // 标题
      bodyXml += `<w:p><w:pPr><w:pStyle w:val="Heading${p.level}"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="宋体"/></w:rPr><w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r></w:p>`
    } else {
      // 正文段落：首行缩进2字符（中文排版）
      bodyXml += `<w:p><w:pPr><w:ind w:firstLineChars="200" w:firstLine="480"/><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r></w:p>`
    }
  }

  // ── OOXML 模板 ──────────────────────────────────────────
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

  const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
xmlns:mo="http://schemas.microsoft.com/office/mac/office/2008/main"
xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
xmlns:mv="urn:schemas-microsoft-com:mac:vml"
xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
xmlns:v="urn:schemas-microsoft-com:vml"
xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
xmlns:w10="urn:schemas-microsoft-com:office:word"
xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
mc:Ignorable="w14 wp14">
<w:body>${bodyXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body>
</w:document>`

  // styles.xml — 定义标题样式 + 默认正文字体
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
<w:sz w:val="24"/><w:szCs w:val="24"/>
</w:rPr></w:rPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/><w:jc w:val="center"/></w:pPr>
<w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/></w:pPr>
<w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>
<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/></w:pPr>
<w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
</w:styles>`

  // ── 打包 ZIP ────────────────────────────────────────────
  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(wordRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml, 'utf8') },
  ]

  const zipBuf = createZipStore(files)
  fs.writeFileSync(outputPath, zipBuf)
}

// ═══════════════════════════════════════════════════════════
//  docxToMd — DOCX → Markdown
// ═══════════════════════════════════════════════════════════
/**
 * @param {string} inputPath  .docx 文件路径
 * @returns {string}  Markdown 纯文本
 */
function docxToMd(inputPath) {
  const zipBuf = fs.readFileSync(inputPath)

  // 提取 word/document.xml
  const docXml = extractFileFromZip(zipBuf, 'word/document.xml')
  if (!docXml) {
    throw new Error('docx 文件中未找到 word/document.xml，文件可能已损坏')
  }

  // 提取 word/styles.xml（用于检测标题样式映射）
  const stylesXml = extractFileFromZip(zipBuf, 'word/styles.xml') || ''

  // 解析样式映射：styleId → heading level
  const headingMap = parseHeadingStyles(stylesXml)

  // 解析段落
  const paragraphs = parseDocumentXml(docXml, headingMap)

  // 拼装 Markdown
  const mdLines = []
  for (const p of paragraphs) {
    if (p.level > 0) {
      const prefix = '#'.repeat(p.level)
      mdLines.push(`${prefix} ${p.text}`)
      mdLines.push('')  // 标题后空行
    } else {
      mdLines.push(p.text)
    }
  }

  // 清理：合并多余空行为最多一个，去首尾空行
  let md = mdLines.join('\n')
  md = md.replace(/\n{3,}/g, '\n\n')
  md = md.replace(/^\n+/, '').replace(/\n+$/, '')

  return md + '\n'
}

// ═══════════════════════════════════════════════════════════
//  ZIP 内部实现
// ═══════════════════════════════════════════════════════════

/**
 * 创建 STORE 方式的 ZIP 文件
 * @param {{ name: string, data: Buffer }[]} files
 * @returns {Buffer}
 */
function createZipStore(files) {
  const localHeaders = []
  const centralEntries = []
  let offset = 0

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf8')
    const fileCrc = crc32(file.data)
    const fileSize = file.data.length

    // Local file header (30 + name + data)
    const localHeader = Buffer.alloc(30 + nameBuffer.length)
    localHeader.writeUInt32LE(0x04034b50, 0)    // signature
    localHeader.writeUInt16LE(20, 4)             // version needed
    localHeader.writeUInt16LE(0, 6)              // flags
    localHeader.writeUInt16LE(0, 8)              // compression: STORE
    localHeader.writeUInt16LE(0, 10)             // mod time
    localHeader.writeUInt16LE(0, 12)             // mod date
    localHeader.writeUInt32LE(fileCrc, 14)       // crc-32
    localHeader.writeUInt32LE(fileSize, 18)      // compressed size
    localHeader.writeUInt32LE(fileSize, 22)      // uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26)  // name length
    localHeader.writeUInt16LE(0, 28)             // extra length
    nameBuffer.copy(localHeader, 30)

    localHeaders.push(Buffer.concat([localHeader, file.data]))

    // Central directory entry (46 + name)
    const centralEntry = Buffer.alloc(46 + nameBuffer.length)
    centralEntry.writeUInt32LE(0x02014b50, 0)   // signature
    centralEntry.writeUInt16LE(20, 4)            // version made by
    centralEntry.writeUInt16LE(20, 6)            // version needed
    centralEntry.writeUInt16LE(0, 8)             // flags
    centralEntry.writeUInt16LE(0, 10)            // compression: STORE
    centralEntry.writeUInt16LE(0, 12)            // mod time
    centralEntry.writeUInt16LE(0, 14)            // mod date
    centralEntry.writeUInt32LE(fileCrc, 16)      // crc-32
    centralEntry.writeUInt32LE(fileSize, 20)     // compressed size
    centralEntry.writeUInt32LE(fileSize, 24)     // uncompressed size
    centralEntry.writeUInt16LE(nameBuffer.length, 28)  // name length
    centralEntry.writeUInt16LE(0, 30)            // extra length
    centralEntry.writeUInt16LE(0, 32)            // comment length
    centralEntry.writeUInt16LE(0, 34)            // disk start
    centralEntry.writeUInt16LE(0, 36)            // internal attrs
    centralEntry.writeUInt32LE(0, 38)            // external attrs
    centralEntry.writeUInt32LE(offset, 42)       // local header offset
    nameBuffer.copy(centralEntry, 46)

    centralEntries.push(centralEntry)
    offset += 30 + nameBuffer.length + fileSize
  }

  // Central directory
  const centralDir = Buffer.concat(centralEntries)
  const centralDirOffset = offset
  const centralDirSize = centralDir.length

  // EOCD (22 bytes)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)              // signature
  eocd.writeUInt16LE(0, 4)                        // disk number
  eocd.writeUInt16LE(0, 6)                        // disk with central dir
  eocd.writeUInt16LE(files.length, 8)             // entries on disk
  eocd.writeUInt16LE(files.length, 10)            // total entries
  eocd.writeUInt32LE(centralDirSize, 12)          // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16)        // central dir offset
  eocd.writeUInt16LE(0, 20)                       // comment length

  return Buffer.concat([...localHeaders, centralDir, eocd])
}

/**
 * 从 ZIP buffer 中提取指定文件内容
 * @param {Buffer} zipBuf  ZIP 文件二进制
 * @param {string} targetName  要提取的文件名（如 "word/document.xml"）
 * @returns {string|null}  文件内容（UTF-8 字符串）或 null
 */
function extractFileFromZip(zipBuf, targetName) {
  // 找 EOCD (End of Central Directory Record)
  // EOCD 签名 = 0x06054b50，在文件末尾附近搜索
  let eocdOffset = -1
  const searchStart = Math.max(0, zipBuf.length - 65557)  // EOCD max = 22 + 65535 comment
  for (let i = zipBuf.length - 22; i >= searchStart; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }

  if (eocdOffset === -1) {
    throw new Error('无效的 ZIP 文件：未找到 EOCD 记录')
  }

  const centralDirOffset = zipBuf.readUInt32LE(eocdOffset + 16)
  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10)

  // 遍历 Central Directory
  let pos = centralDirOffset
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > zipBuf.length) break
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break

    const compressionMethod = zipBuf.readUInt16LE(pos + 10)
    const compressedSize = zipBuf.readUInt32LE(pos + 20)
    const uncompressedSize = zipBuf.readUInt32LE(pos + 24)
    const nameLen = zipBuf.readUInt16LE(pos + 28)
    const extraLen = zipBuf.readUInt16LE(pos + 30)
    const commentLen = zipBuf.readUInt16LE(pos + 32)
    const localHeaderOffset = zipBuf.readUInt32LE(pos + 42)

    const entryName = zipBuf.slice(pos + 46, pos + 46 + nameLen).toString('utf8')

    if (entryName === targetName) {
      // 跳到 local file header，读取 data
      const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26)
      const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28)
      const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen

      let fileData
      if (compressionMethod === 0) {
        // STORE
        fileData = zipBuf.slice(dataOffset, dataOffset + uncompressedSize)
      } else if (compressionMethod === 8) {
        // DEFLATE
        const compressed = zipBuf.slice(dataOffset, dataOffset + compressedSize)
        try {
          fileData = zlib.inflateRawSync(compressed)
        } catch (e) {
          throw new Error(`ZIP 解压失败 (${entryName}): ${e.message}`)
        }
      } else {
        throw new Error(`不支持的 ZIP 压缩方法: ${compressionMethod} (文件: ${entryName})`)
      }

      return fileData.toString('utf8')
    }

    pos += 46 + nameLen + extraLen + commentLen
  }

  return null
}

// ═══════════════════════════════════════════════════════════
//  OOXML 解析
// ═══════════════════════════════════════════════════════════

/**
 * 解析 styles.xml，建立 styleId → heading level 映射
 * 支持 WPS/Word 生成的各种标题样式名
 */
function parseHeadingStyles(stylesXml) {
  const map = {}

  // 标准内置样式 ID
  map['Heading1'] = 1; map['Heading2'] = 2; map['Heading3'] = 3
  map['heading1'] = 1; map['heading2'] = 2; map['heading3'] = 3
  // WPS 中文样式
  map['1'] = 1; map['2'] = 2; map['3'] = 3

  if (!stylesXml) return map

  // 用正则解析 <w:style> 块，提取 styleId 和 w:name
  const styleRegex = /<w:style[^>]*w:styleId="([^"]*)"[^>]*>([\s\S]*?)<\/w:style>/g
  let match
  while ((match = styleRegex.exec(stylesXml)) !== null) {
    const styleId = match[1]
    const block = match[2]

    // 检查 w:name val 是否包含 "heading" + 数字
    const nameMatch = block.match(/<w:name\s+w:val="([^"]*)"/i)
    if (nameMatch) {
      const name = nameMatch[1].toLowerCase()
      const headingNumMatch = name.match(/heading\s*(\d)/)
      if (headingNumMatch) {
        const level = parseInt(headingNumMatch[1])
        if (level >= 1 && level <= 6) {
          map[styleId] = level
        }
      }
      // WPS 特殊标题样式名（中文）
      if (name.includes('标题') && !name.includes('副标题')) {
        const cnNum = name.match(/(\d)/)
        if (cnNum) {
          map[styleId] = parseInt(cnNum[1])
        }
      }
    }

    // 也检查 outlineLvl（大纲级别），这是更可靠的标题检测
    const outlineMatch = block.match(/<w:outlineLvl\s+w:val="(\d)"/i)
    if (outlineMatch) {
      const level = parseInt(outlineMatch[1]) + 1  // outlineLvl 从 0 开始
      if (level >= 1 && level <= 6) {
        map[styleId] = level
      }
    }
  }

  return map
}

/**
 * 解析 document.xml，提取段落列表
 * @returns {{ text: string, level: number }[]}
 */
function parseDocumentXml(docXml, headingMap) {
  const paragraphs = []

  // 提取 <w:body> 内容
  const bodyMatch = docXml.match(/<w:body>([\s\S]*)<\/w:body>/)
  if (!bodyMatch) return paragraphs
  const bodyXml = bodyMatch[1]

  // 分割段落 <w:p>...</w:p>
  const pRegex = /<w:p[\s>]([\s\S]*?)<\/w:p>/g
  let pMatch
  while ((pMatch = pRegex.exec(bodyXml)) !== null) {
    const pContent = pMatch[1]

    // 检查段落样式 → 标题级别
    let level = 0
    const styleMatch = pContent.match(/<w:pStyle\s+w:val="([^"]*)"/i)
    if (styleMatch) {
      const styleId = styleMatch[1]
      if (headingMap[styleId]) {
        level = headingMap[styleId]
      }
    }

    // 也检查段落级别的 outlineLvl
    if (level === 0) {
      const pOutlineMatch = pContent.match(/<w:outlineLvl\s+w:val="(\d)"/i)
      if (pOutlineMatch) {
        level = parseInt(pOutlineMatch[1]) + 1
        if (level > 6) level = 0
      }
    }

    // 提取所有 <w:t> 的文本内容
    const texts = []
    const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
    let tMatch
    while ((tMatch = tRegex.exec(pContent)) !== null) {
      texts.push(unescapeXml(tMatch[1]))
    }

    // 检测换行符 <w:br/>
    if (/<w:br\s*\/?>/.test(pContent) && texts.length > 0) {
      // 段落内有换行，拆分为多个段落
      const fullText = texts.join('')
      const subLines = fullText.split(/\n/)
      for (const sub of subLines) {
        paragraphs.push({ text: sub, level })
      }
    } else {
      const text = texts.join('')
      paragraphs.push({ text, level })
    }
  }

  return paragraphs
}

/**
 * 反转义 XML 实体
 */
function unescapeXml(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// ═══════════════════════════════════════════════════════════
//  导出
// ═══════════════════════════════════════════════════════════
module.exports = { mdToDocx, docxToMd }

// ── CLI 直接调用 ──────────────────────────────────────────
if (require.main === module) {
  const [,, cmd, input, output] = process.argv
  if (cmd === 'md2docx' && input && output) {
    const md = fs.readFileSync(input, 'utf8')
    mdToDocx(md, output)
    console.log(JSON.stringify({ ok: true, output }))
  } else if (cmd === 'docx2md' && input) {
    const md = docxToMd(input)
    if (output) {
      fs.writeFileSync(output, md, 'utf8')
      console.log(JSON.stringify({ ok: true, output }))
    } else {
      process.stdout.write(md)
    }
  } else {
    console.error('用法:\n  node docx-utils.js md2docx <input.md> <output.docx>\n  node docx-utils.js docx2md <input.docx> [output.md]')
    process.exit(1)
  }
}
