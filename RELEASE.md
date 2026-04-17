# 独立发布说明

我已经把 `novel-writer` 整理成可独立分发的 Claude Code 插件。

## 当前可直接拿去发布的目录

- `plugins/novel-writer`

这个目录已经包含：
- `.claude-plugin/plugin.json`
- `README.md`
- `CHANGELOG.md`
- `skills/novel-writer/SKILL.md`
- `skills/novel-writer/flows/`
- `skills/novel-writer/references/`
- `skills/novel-writer/scripts/`
- `skills/novel-writer/workspace.yaml.default`

## 版本

当前版本：`0.1.0`

## 这个“仓库”是什么意思

你可以把“仓库”理解成：
- 一个单独的项目文件夹
- 里面放这一个插件要发布的全部文件
- 以后版本更新也只更新这个文件夹/项目

简单说：
**如果你要让插件独立版本化，就要把 `plugins/novel-writer` 单独放到一个新的项目里。**

## 你之后需要做的事

我已经先把代码和文档准备好了。接下来你只需要做这几件人工操作：

1. 新建一个单独文件夹，名字建议：
   - `claude-code-plugin-novel-writer`
2. 把当前仓库里的 `plugins/novel-writer` 整个复制进去
3. 如果你用 GitHub，再把这个新文件夹上传成一个新的 GitHub 项目
4. 以后插件升级，就在那个独立项目里继续改版本号、写更新说明、发布新版本

## 如果你暂时不想新建独立项目

也可以先把这个目录单独打包保存，后续再拆出去。

建议保留完整目录结构，不要只拷部分文件。
