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

### 方式三：作为 OpenClaw / 龙虾 workspace skill 使用

OpenClaw 的 workspace skill 目录默认是：

```text
~/.openclaw/workspace/skills/
```

安装方法：

1. 在 OpenClaw 工作空间下创建技能目录：
   - `~/.openclaw/workspace/skills/novel-writer/`
2. 将本仓库中的以下内容完整复制进去：
   - `skills/novel-writer/SKILL.md`
   - `skills/novel-writer/flows/`
   - `skills/novel-writer/references/`
   - `skills/novel-writer/scripts/`
   - `skills/novel-writer/workspace.yaml.default`
3. 如需初始化工作空间配置，可在 OpenClaw skill 目录下执行：

```bash
node ~/.openclaw/workspace/skills/novel-writer/scripts/install.js ~/.openclaw/workspace/skills/novel-writer
```

4. 然后用 OpenClaw 检查技能是否已生效：

```bash
openclaw skills list
openclaw skills info novel-writer
```

如果状态显示为 `Ready`，说明 OpenClaw 已经识别并加载该技能。

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

已完成 **OpenClaw 真实请求兼容实测**。

目前已经确认：

- `novel-writer` 可被 OpenClaw 识别为 workspace skill
- 技能可在 OpenClaw 中被成功加载
- 通过 `openclaw skills list` 可见该技能
- 通过 `openclaw skills info novel-writer` 可见状态为 **`Ready`**
- OpenClaw 已通过自定义 OpenAI 兼容 provider 成功完成本地 agent 调用
- 本地测试链路返回成功结果：**`OPENCLAW-LOCAL-OK`**
- 实测日志中可见 `novel-writer` 已进入 agent 的 skills 上下文
- 在真实请求（如“工作台”）下，已返回小说工作台风格内容，说明 `novel-writer` 工作流已被实际命中

这说明本项目的技能目录结构（`SKILL.md` + `flows/` + `references/` + `scripts/`）与 OpenClaw 的 skills 机制兼容，并且本地 agent 调用链路已经跑通。

当前已经完成的实测范围是：

- **技能识别成功**
- **技能加载成功**
- **技能状态为 Ready**
- **自定义 OpenAI 兼容 provider 已接通**
- **OpenClaw 本地 agent 调用成功执行（Exit code: 0）**
- **真实“工作台”请求已返回小说助手风格内容**

当前仍可继续优化的部分是：

- 某些工具权限与脚本调用细节在 OpenClaw 下仍可能需要适配
- 若要覆盖完整小说流程，建议继续补测 `新建项目`、`继续写` 等真实请求

因此目前最准确的表述是：

- **已在 OpenClaw 中完成真实请求兼容实测**
- **适合在 OpenClaw 中作为 workspace skill 使用**
- **自定义 OpenAI 兼容模型链路已验证可用**
- **真实工作台请求已验证可命中 novel-writer 工作流**

## 版本文件

当前仓库包含：

- `.claude-plugin/plugin.json`
- `README.md`
- `CHANGELOG.md`
- `skills/novel-writer/**`

## 说明

这是一个**纯文本版**小说创作插件，不包含任何 GUI 或图形界面入口。
