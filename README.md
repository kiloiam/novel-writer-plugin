# 小说写作助手插件

这是一个面向 Claude Code 的长篇小说创作插件，提供从立项、设定、大纲，到续写、润色、回滚与整理导出的完整工作流。

## 功能简介

本插件提供 `novel-writer` 技能，可用于：

- 工作空间与项目管理
- 题材调查、世界观构建与大纲规划
- 章节续写、指定章节写作与前情回顾
- 重写、润色、导入、恢复、撤销与回滚
- 时间线、人物关系、伏笔与全文搜索
- 整理导出与发布前准备

## 安装方法

### 方式一：作为 Claude Code 插件使用

将本项目作为一个独立插件目录使用，确保目录结构包含：

- `.claude-plugin/plugin.json`
- `skills/novel-writer/SKILL.md`
- `skills/novel-writer/flows/`
- `skills/novel-writer/references/`
- `skills/novel-writer/scripts/`
- `skills/novel-writer/workspace.yaml.default`

安装后，首次使用时可运行：

```bash
node skills/novel-writer/scripts/install.js skills/novel-writer
```

它会根据 `workspace.yaml.default` 生成 `workspace.yaml`，且不会覆盖已有配置。

### 方式二：手动复制到你的插件项目中

如果你有自己的 Claude Code 插件项目，可直接把本仓库内容复制进去，保留目录结构不变即可。

## 使用方法（完全支持自然语言，而且懒人化程度很高）

你可以直接通过 `novel-writer` 调用，示例：

```text
novel-writer 工作台
novel-writer 新建项目
novel-writer 继续写
novel-writer 润色
novel-writer 整合
```

支持的常见操作包括：

- 工作空间 / 列出项目 / 新建 / 工作台 / 进度 / 状态
- 调查 / 世界观 / 大纲
- 继续写 / 写 / 回顾 / 脑暴
- 导入 / 删除章节 / 历史 / 恢复 / 撤销
- 重写 / 重写段落
- 润色 / 整合 / 设定检查 / 改设定 / 关系图谱 / 搜索

## 工作空间说明

插件会通过 `workspace.yaml` 管理小说工作空间。首次安装时，`skills/novel-writer/scripts/install.js` 会从 `workspace.yaml.default` 生成 `workspace.yaml`。

为了更稳妥地写作，建议将工作空间放在本地磁盘，而不是热同步云盘目录中。

## 项目内容

- **技能：** `novel-writer`
- **流程：** planning、writing、chapter-manage、chapter-modify、editing
- **脚本：** 保存章节、导入/删除/恢复章节、重编号、元数据更新、编译导出、搜索、加锁等工具

## 关于 OpenClaw / 龙虾

我已根据当前插件结构做了兼容性判断：本项目本质上是一个 **基于 `SKILL.md` + `scripts/` + 插件目录结构的文本型技能插件**。如果 OpenClaw / 龙虾支持与 Claude Code 相同或兼容的技能目录结构、frontmatter 字段以及脚本调用方式，则**有较大概率可以接入或迁移使用**。

但我目前**还没有拿到 OpenClaw 官方文档中的明确插件兼容说明**，因此这里先给出谨慎表述：

- **可以尝试接入 OpenClaw / 龙虾**
- **是否开箱即用，仍建议你在 OpenClaw 中做一次实际安装测试**

如果你后续确认 OpenClaw 对 Claude Code 的 `SKILL.md` / `.claude-plugin/plugin.json` 兼容，我可以再把这里改成更明确的兼容说明。

## 版本文件

当前仓库包含：

- `.claude-plugin/plugin.json`
- `README.md`
- `CHANGELOG.md`
- `skills/novel-writer/**`

## 说明

这是一个**纯文本版**小说创作插件，不包含任何 GUI 或图形界面入口。
