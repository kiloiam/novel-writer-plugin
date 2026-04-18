# 创作规划流程

> 本文件包含：市场调研、世界观构建、大纲撰写

---

## 市场调研（可选）

触发：`调查`、`市场分析`、`题材研究`

分析热门题材、平台特征、爆款规律，给出创作方向建议。

- 使用 WebSearch 获取当前市场数据
- 输出格式：调研报告（热门分析 → 爆款规律 → 推荐方向）
- 这是**可选步骤**，用户可以跳过直接写

**展示格式：**

```
《题材》市场调研报告
━━━━━━━━━━━━━━━━━━━━
热门趋势：...
爆款规律：...
推荐方向：2-3 个具体方向
━━━━━━━━━━━━━━━━━━━━
建议操作：选择方向后新建项目 / 直接开写
```

---

## 世界观构建

触发：`世界观`、`世界设定`、`设定世界`

根据题材类型深度构建世界观。**不同题材生成不同的设定文件**，而非强制套用固定模板。

**按题材自动决定输出文件：**

| 题材 | 生成的 worldbuilding/ 文件 |
|------|--------------------------| 
| 玄幻/仙侠 | 力量体系.md、地理版图.md、种族势力.md、修炼资源.md |
| 科幻 | 科技体系.md、星际地理.md、社会形态.md、物种文明.md |
| 都市/现代 | 行业生态.md、城市背景.md、社会关系.md |
| 历史/古代 | 朝代制度.md、社会结构.md、风俗礼制.md、地理势力.md |
| 末世 | 灾变设定.md、生存体系.md、势力版图.md、变异生态.md |
| 悬疑 | 案件架构.md、线索网络.md、背景设定.md |

**构建原则：**
- 服务于故事，不为设定而设定——每个设定都应产生剧情可能性
- 冰山原则：构建 100%，展示 20%
- 规则优先于例外——先确立规则，例外作为剧情爆点
- 一个精准的生活细节胜过十段宏大设定

**写实题材增强**：都市/历史等题材使用 WebSearch 调研真实背景（行话、风俗、行业细节）

**参考模板**（按需读取）：`Read ${CLAUDE_SKILL_DIR}/references/worldbuilding-template.md`

**保存规则**：世界观文件（`worldbuilding/*.md`）和角色档案（`characters/*.md`）属于元数据文件，**必须通过 `update-metadata.js` 网关写入**，不得直接使用 Write/Edit 工具：
```
# 先将内容写入临时文件，再通过网关保存
node ${CLAUDE_SKILL_DIR}/scripts/update-metadata.js <项目目录> worldbuilding/力量体系.md <临时文件>
```

**构建完成后更新**：`PROJECT.yaml` 的 `updated`、`last_action: {type: "worldbuilding", target: "世界观", timestamp: 当前时间}`

**展示格式：**

```
《书名》世界观构建完成 ✓
━━━━━━━━━━━━━━━━━━━━
题材：玄幻
已创建设定文件：
  - worldbuilding/力量体系.md
  - worldbuilding/地理版图.md
  - worldbuilding/种族势力.md
━━━━━━━━━━━━━━━━━━━━
建议操作：写大纲 / 直接开写第一章
```

---

## 大纲撰写

触发：`大纲`、`架构`、`故事结构`、`章节规划`

构建故事骨架：

1. 读取已有世界观设定（如果有）
2. 设计整体结构（主线/支线/暗线）、人物关系、章节细纲、节奏分布
3. 保存到 `outline/大纲.md`——**必须通过 `update-metadata.js` 网关写入**：
   ```
   node ${CLAUDE_SKILL_DIR}/scripts/update-metadata.js <项目目录> outline/大纲.md <临时文件>
   ```
4. 为主要角色创建 `characters/[角色名].md` 基础档案，保存前必须先净化角色名：
   ```bash
   safe_character=$(bash ${CLAUDE_SKILL_DIR}/scripts/sanitize-filename.sh "原始角色名")
   ```
   角色档案同样通过网关写入：
   ```
   node ${CLAUDE_SKILL_DIR}/scripts/update-metadata.js <项目目录> characters/${safe_character}.md <临时文件>
   ```
5. 更新 `PROJECT.yaml`：`total_chapters`（计划章数，不反映现存）、`status`、`updated`、`last_action: {type: "outline", target: "大纲", timestamp: 当前时间}`

**参考格式**（按需读取）：`Read ${CLAUDE_SKILL_DIR}/references/outline-format.md`

**展示格式：**

```
《书名》大纲完成 ✓
━━━━━━━━━━━━━━━━━━━━
结构：X卷 / 计划共Y章
主线：...
支线：...
已创建角色档案：A、B、C
━━━━━━━━━━━━━━━━━━━━
建议操作：构建世界观 / 开始写第一章
```
