/**
 * text-utils.js — 统一文本规范化工具
 *
 * 所有写入项目文件的脚本都应调用 normalizeText() 处理输入文本。
 * 确保存储层一致性：LF 换行、无 BOM、UTF-8。
 */

/**
 * 规范化文本用于存储
 * - \r\n → \n（Windows CRLF）
 * - \r → \n（旧 Mac CR）
 * - 去除 UTF-8 BOM（\uFEFF）
 * @param {string} text 原始文本
 * @returns {string} 规范化后的文本
 */
function normalizeText(text) {
  if (text == null) return ''
  if (typeof text !== 'string') return String(text)
  return text
    .replace(/\uFEFF/g, '')     // UTF-8 BOM
    .replace(/\r\n/g, '\n')     // Windows CRLF
    .replace(/\r/g, '\n')       // 旧 Mac CR
}

module.exports = { normalizeText }
