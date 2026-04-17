#!/usr/bin/env node
/**
 * install.js — 幂等安装/升级脚本
 *
 * 用法：
 *   node install.js <技能目录>
 *
 * 升级安全保障：
 * - workspace.yaml 若已存在则跳过，不覆盖用户配置
 * - 输出 JSON：{ ok, preserved, created, warnings }
 */
const fs = require('fs')
const path = require('path')

const skillDir = process.argv[2] || path.join(__dirname, '..')

if (!fs.existsSync(skillDir)) {
  console.error(`ERROR: 技能目录不存在: ${skillDir}`)
  process.exit(1)
}

const result = { ok: false, preserved: [], created: [], warnings: [] }

// ── workspace.yaml 保护 ─────────────────────────────────
const wsYaml = path.join(skillDir, 'workspace.yaml')
const wsYamlDefault = path.join(skillDir, 'workspace.yaml.default')

if (fs.existsSync(wsYaml)) {
  // 已存在：保留用户配置
  result.preserved.push('workspace.yaml')
} else if (fs.existsSync(wsYamlDefault)) {
  // 首次安装：从默认模板创建
  fs.copyFileSync(wsYamlDefault, wsYaml)
  result.created.push('workspace.yaml')
} else {
  // 无模板：创建最小配置
  fs.writeFileSync(wsYaml, 'workspace_path: ""\nactive_project: ""\n', 'utf8')
  result.created.push('workspace.yaml')
}

result.ok = true
console.log(JSON.stringify(result, null, 2))
