# PROJECT.yaml 完整格式

```yaml
title: "书名"
genre: "题材"              # 玄幻/都市/科幻/历史/末世/悬疑/言情/...
style: "文风"              # 爽文流/细腻流/古风流/轻小说流/悬疑流/硬科幻流
target_words: 100000       # 目标字数
chapter_target_words: 3000 # 每章目标字数
platform: "起点"           # 目标平台
status: planning           # planning → writing → polishing → completed

# 进度
current_chapter: 5         # 写作指针：最近写作/编辑的章节编号。现存最大编号由 count/list 脚本运行时扫描获取
total_chapters: 20         # 计划总章数，仅代表计划，可随时调整。现存章节数由运行时扫描得出
current_volume: 1          # 当前卷

# 上下文提示（辅助 AI 智能加载）
active_characters:         # 当前滚动工作集（最近几章仍值得持续加载的核心角色，建议控制在 3-6 个）
  - 苏然
  - 索菲
focus_plotlines:           # 当前推进中的情节线（滚动保留近期仍在推进的主/支线，建议控制在 2-4 条）
  - 主线：调查梦境异常
  - 支线：与索菲的信任建立
next_chapter_note: ""      # 下一章的特别备注（用户可手写）

# 最近操作（跨会话恢复上下文用）
last_action:
  type: "write"            # 见下方 last_action.type 完整定义
  target: "第005章"        # 操作目标（单章操作时使用）
  targets:                 # 多章操作时使用（如批量删除/导入），与 target 二选一
    - "第003章"
    - "第005章"
  affected_files:          # 可选：受影响的元数据文件列表（辅助撤销判断 / 待补同步提示）
    - "chapter-log.md"
    - "foreshadowing.md"
  draft_snapshots:         # 可选：同步失败回撤时保留的草稿快照
    - "chapters/_drafts/第005章-章节名--20260418-120000-123--manual-edit-draft.md"
  timestamp: "2026-04-15T18:20:00"

created: 2026-04-14
updated: 2026-04-14
```

> `active_characters` 和 `focus_plotlines` 是智能加载的关键——AI 据此决定读哪些角色档案和设定文件，而不是每次全读。
>
> 更新规则：它们不是「仅由本章重新算出的瞬时结果」，而是**有上限的滚动工作集**。每次保存时，应保留近期仍重要的核心项，再合并本章新增核心项；不要因为某角色/情节线在单章缺席，就立刻从后续加载入口中删除。
>
> 对 `manual-edit`，推荐采用原子事务口径：同步只有“完整成功”与“自动回撤”两种对外结果。若无法完成必需同步步骤，系统应恢复到 `pre-edit` 快照，并在 `draft_snapshots` 中保留用户本次编辑内容，避免辛苦写的文本丢失。

## last_action.type 完整定义与撤销能力

| type | 说明 | 撤销方式 |
|------|------|---------|
| `write` | 写作/续写 | **自动**：有 `_history/` 快照则恢复；无快照（首次写入）则删除新章 + 回滚日志/进度 |
| `rewrite` | 章节重写 | **自动**：从 `_history/` 恢复 rewrite 快照 |
| `polish` | 润色 | **自动**：从 `_history/` 恢复 polish 快照 |
| `paragraph` | 段落重写 | **自动**：从 `_history/` 恢复 paragraph 快照 |
| `delete` | 章节删除 | **自动**：从 `_deleted/` 恢复（含重编号） |
| `import` | 章节导入 | **需确认**：提示用户确认影响范围后手动恢复 |
| `restore` | 历史恢复 | **需确认**：提示用户确认影响范围后手动恢复 |
| `outline` | 大纲撰写 | **不可自动撤销**：提示用户手动编辑 outline/大纲.md |
| `worldbuilding` | 世界观构建 | **不可自动撤销**：提示用户手动编辑 worldbuilding/ 文件 |
| `edit_setting` | 设定编辑 | **不可自动撤销**：提示用户手动编辑对应设定文件 |
| `relationships` | 关系图谱生成 | **不可自动撤销**：提示用户手动编辑 relationships.md |
| `inspect` | 一致性巡检 | **不需要撤销**：巡检只读不写（除日志追加） |
| `manual-edit` | 手工编辑成功提交 | **自动**：从 `_history/` 恢复 pre-edit 快照 |
| `manual-edit-rolled-back` | 手工编辑未能完整同步，已自动回撤 | **通常不需要撤销**：正文已恢复到 pre-edit；如要找回内容，读取 `draft_snapshots` 中的草稿快照 |
