# Novel Writer Plugin

A Claude Code plugin for long-form fiction writing workflows.

## What It Does

This plugin adds the `novel-writer` skill for managing novel projects end to end:

- project setup and workspace management
- story research, worldbuilding, and outlining
- chapter drafting and continuation
- rewrite, polish, import, restore, and rollback flows
- timeline, relationships, foreshadowing, and search workflows
- compilation and export preparation

## Installation

Install the plugin through the Claude Code plugin system or by placing this plugin directory into a standalone Claude Code plugin project.

## Usage

Invoke the skill with natural-language writing intents or direct action names, for example:

```text
novel-writer 工作台
novel-writer 新建项目
novel-writer 继续写
novel-writer 润色
novel-writer 整合
```

Supported actions include:

- 工作空间 / 列出项目 / 新建 / 工作台 / 进度 / 状态
- 调查 / 世界观 / 大纲
- 继续写 / 写 / 回顾 / 脑暴
- 导入 / 删除章节 / 历史 / 恢复 / 撤销
- 重写 / 重写段落
- 润色 / 整合 / 设定检查 / 改设定 / 关系图谱 / 搜索

## Workspace

The skill manages novel projects in a workspace configured through `workspace.yaml`. On first install, `skills/novel-writer/scripts/install.js` creates `workspace.yaml` from `workspace.yaml.default` without overwriting an existing configuration.

For safer operation, keep the workspace on a local disk instead of a hot-sync cloud folder.

## Plugin Contents

- **Skill:** `novel-writer`
- **Flows:** planning, writing, chapter management, chapter modification, editing
- **Scripts:** chapter save/import/delete/restore, renumbering, metadata updates, compile/export helpers, search, and locking utilities

## Release Files

This plugin directory is prepared for standalone release and includes:

- `.claude-plugin/plugin.json`
- `README.md`
- `CHANGELOG.md`
- `RELEASE.md`
- `skills/novel-writer/**`

## Notes

This plugin is intentionally text-only. It does not include any GUI command or graphical workspace entry.
