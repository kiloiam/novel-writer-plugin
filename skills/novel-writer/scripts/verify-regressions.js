#!/usr/bin/env node
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const skillDir = path.resolve(__dirname, '..')
const fixturesDir = path.join(skillDir, 'fixtures')
const compileScript = path.join(__dirname, 'compile.js')
const saveChapterScript = path.join(__dirname, 'save-chapter.js')
const editChapterScript = path.join(__dirname, 'edit-chapter.js')
const deleteChapterScript = path.join(__dirname, 'delete-chapter.js')
const syncEditScript = path.join(__dirname, 'sync-edit.js')

function logPass(message) {
  console.log(`PASS ${message}`)
}

function logFail(message) {
  console.error(`FAIL ${message}`)
}

function ensure(condition, message) {
  if (!condition) throw new Error(message)
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath)
    } else {
      fs.copyFileSync(srcPath, dstPath)
    }
  }
}

function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
}

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function testCompileBrokenSymlink() {
  return withTempDir('novel-reg-compile-', tempDir => {
    const fixture = path.join(fixturesDir, 'compile-broken-symlink')
    const projectDir = path.join(tempDir, 'project')
    copyDir(fixture, projectDir)

    const outputFile = path.join(projectDir, '发布版.md')
    let symlinkCreated = false
    try {
      fs.symlinkSync(path.join(projectDir, 'missing-target.md'), outputFile)
      symlinkCreated = true
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'UNKNOWN') {
        console.log('SKIP compile broken symlink test (symlink permission unavailable on this system)')
        return
      }
      throw error
    }

    ensure(symlinkCreated, 'broken symlink fixture was not created')

    const result = runNode(compileScript, [projectDir])
    ensure(result.status !== 0, 'compile.js should reject broken symlink target')
    ensure(result.stderr.includes('是符号链接，拒绝操作'), 'compile.js stderr should mention symlink refusal')
    ensure(!result.stdout.includes('整合完成！'), 'compile.js should not report successful completion')
    logPass('compile.js rejects broken symlink 发布版.md')
  })
}

function testSaveInvalidUtf8() {
  return withTempDir('novel-reg-save-', tempDir => {
    const fixture = path.join(fixturesDir, 'save-invalid-utf8')
    const projectDir = path.join(tempDir, 'project')
    copyDir(fixture, projectDir)

    const badFile = path.join(tempDir, 'bad.md')
    fs.writeFileSync(badFile, Buffer.from([0xff, 0xfe, 0x00, 0x61, 0x62, 0x63]))

    const result = runNode(saveChapterScript, [projectDir, '1', badFile, '--title', 'test'])
    ensure(result.status !== 0, 'save-chapter.js should reject invalid UTF-8 input')
    ensure(result.stderr.includes('文件编码不是 UTF-8'), 'save-chapter.js stderr should mention invalid UTF-8')

    const chapterFile = path.join(projectDir, 'chapters', '第001章-test.md')
    ensure(!fs.existsSync(chapterFile), 'save-chapter.js should not write chapter file on invalid UTF-8 input')
    logPass('save-chapter.js rejects invalid UTF-8 without writing chapter file')
  })
}

function testSyncEditTracksOriginalChapterAfterRenumber() {
  return withTempDir('novel-reg-sync-edit-', tempDir => {
    const fixture = path.join(fixturesDir, 'stress-project')
    const projectDir = path.join(tempDir, 'project')
    copyDir(fixture, projectDir)

    const seed = {
      '第001章-起始.md': '# 第一章\n\n这是第一章正文。\n\n主角出场。',
      '第002章-升温.md': '# 第二章\n\n这是第二章正文。\n\n冲突升级。',
      '第003章-悬念.md': '# 第三章\n\n这是第三章正文。\n\n悬念埋设。',
    }
    for (const [name, content] of Object.entries(seed)) {
      fs.writeFileSync(path.join(projectDir, 'chapters', name), content, 'utf8')
    }
    fs.writeFileSync(path.join(projectDir, 'chapter-log.md'), [
      '# 章节日志',
      '',
      '## 第1章 - 起始',
      '- **概况**：主角出场。',
      '- **关键事件**：',
      '  - 进入舞台',
      '- **人物变化**：主角登场',
      '- **伏笔**：神秘线索',
      '- **字数**：约10字',
      '',
      '## 第2章 - 升温',
      '- **概况**：冲突升级。',
      '- **关键事件**：',
      '  - 敌人出现',
      '- **人物变化**：压力增加',
      '- **伏笔**：危险升级',
      '- **字数**：约10字',
      '',
      '## 第3章 - 悬念',
      '- **概况**：悬念埋设。',
      '- **关键事件**：',
      '  - 抛出疑问',
      '- **人物变化**：主角困惑',
      '- **伏笔**：终局线索',
      '- **字数**：约10字',
      '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(path.join(projectDir, 'PROJECT.yaml'), [
      'title: stress-project',
      'status: drafting',
      'current_chapter: 3',
      'active_characters: []',
      'focus_plotlines: []',
      '',
    ].join('\n'), 'utf8')

    const editResult = runNode(editChapterScript, [projectDir, '2'])
    ensure(editResult.status === 0, 'edit-chapter.js should prepare chapter 2 for manual edit')

    const markerPath = path.join(projectDir, 'chapters', '.edit-marker-2.json')
    ensure(fs.existsSync(markerPath), 'edit marker for chapter 2 should be created')
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    ensure(marker.chapter_file === '第002章-升温.md', 'edit marker should record original chapter file')

    const originalEditedPath = path.join(projectDir, 'chapters', marker.chapter_file)
    const wrongSlotPath = path.join(projectDir, 'chapters', '第003章-悬念.md')
    fs.appendFileSync(originalEditedPath, '\n\n手工编辑追加一句。\n', 'utf8')

    const deleteResult = runNode(deleteChapterScript, [projectDir, '1'])
    ensure(deleteResult.status === 0, 'delete-chapter.js should delete chapter 1 and renumber later chapters')

    const syncResult = runNode(syncEditScript, [projectDir])
    ensure(syncResult.status === 0, 'sync-edit.js should succeed after renumbering')
    ensure(syncResult.stdout.includes('committed_manual_edit'), 'sync-edit.js should commit the manual edit')

    const renumberedEditedPath = path.join(projectDir, 'chapters', '第001章-升温.md')
    const renumberedWrongPath = path.join(projectDir, 'chapters', '第002章-悬念.md')
    ensure(fs.existsSync(renumberedEditedPath), 'renumbered edited chapter should exist at new number')
    ensure(fs.existsSync(renumberedWrongPath), 'renumbered unrelated chapter should still exist')

    const editedContent = fs.readFileSync(renumberedEditedPath, 'utf8')
    const wrongContent = fs.readFileSync(renumberedWrongPath, 'utf8')
    ensure(editedContent.includes('手工编辑追加一句。'), 'manual edit should stay with the original logical chapter after renumber')
    ensure(!wrongContent.includes('手工编辑追加一句。'), 'manual edit should not drift to the chapter that inherited the old number')

    const logContent = fs.readFileSync(path.join(projectDir, 'chapter-log.md'), 'utf8')
    ensure(logContent.includes('## 第1章 - 升温'), 'chapter log should contain the renumbered edited chapter heading')
    ensure(logContent.includes('- **手工编辑**：'), 'chapter log should record manual edit metadata')
    ensure(!logContent.includes('## 第2章 - 升温'), 'chapter log should not keep the edited chapter under the stale number')

    const editedBlockMatch = logContent.match(/## 第1章 - 升温[\s\S]*?(?=\n## |$)/)
    ensure(editedBlockMatch && editedBlockMatch[0].includes('- **手工编辑**：'), 'manual edit metadata should be attached to the resolved chapter block')

    const projectYaml = fs.readFileSync(path.join(projectDir, 'PROJECT.yaml'), 'utf8')
    ensure(/current_chapter:\s*1\b/.test(projectYaml), 'PROJECT.yaml should track the resolved chapter number')
    ensure(projectYaml.includes('type: manual-edit'), 'PROJECT.yaml should record manual-edit as the last action')
    ensure(projectYaml.includes('- 第1章'), 'PROJECT.yaml last_action should target the resolved chapter number')
    ensure(!projectYaml.includes('- 第2章'), 'PROJECT.yaml should not keep stale chapter target metadata for the edited chapter')

    ensure(!fs.existsSync(markerPath), 'sync-edit.js should clean up the consumed marker file')

    logPass('sync-edit.js keeps manual edits attached to the original chapter after renumber')
  })
}

function testSyncEditPreservesSceneWhenRecoverySourceMissing() {
  return withTempDir('novel-reg-missing-preedit-', tempDir => {
    const fixture = path.join(fixturesDir, 'stress-rollback-missing-preimage')
    const projectDir = path.join(tempDir, 'project')
    copyDir(fixture, projectDir)

    const chapterPath = path.join(projectDir, 'chapters', '第001章-起始.md')
    const sentinel = '手工脏内容-保留校验'
    fs.appendFileSync(chapterPath, `\n\n${sentinel}\n`, 'utf8')

    const result = runNode(syncEditScript, [projectDir])
    ensure(result.status !== 0, 'sync-edit.js should fail when pre-edit recovery sources are missing')

    const payload = JSON.parse(result.stdout)
    ensure(payload.ok === false, 'sync-edit.js should report failure when rollback is unavailable')
    ensure(payload.status === 'manual_intervention_required_missing_pre_edit_snapshot', 'sync-edit.js should expose the preserve-scene status')
    ensure(payload.rollback_unavailable === true, 'sync-edit.js should keep rollback_unavailable flag for compatibility')
    ensure(payload.message.includes('无法执行自动回撤'), 'sync-edit.js message should explain rollback is impossible')
    ensure(payload.message.includes('已保留当前章节中的手工编辑内容现场'), 'sync-edit.js message should explain dirty content is preserved')
    ensure(payload.message.includes('未自动提交'), 'sync-edit.js message should explain commit did not happen')
    ensure(payload.message.includes('未清理编辑标记'), 'sync-edit.js message should explain marker is retained')

    ensure(fs.existsSync(path.join(projectDir, 'chapters', '.edit-marker-1.json')), 'edit marker should remain for manual handling')
    ensure(fs.readFileSync(chapterPath, 'utf8').includes(sentinel), 'dirty edited chapter content should remain in place')

    logPass('sync-edit.js preserves scene honestly when pre-edit recovery sources are missing')
  })
}

function main() {
  const tests = [
    testCompileBrokenSymlink,
    testSaveInvalidUtf8,
    testSyncEditTracksOriginalChapterAfterRenumber,
    testSyncEditPreservesSceneWhenRecoverySourceMissing,
  ]

  let failed = false
  for (const test of tests) {
    try {
      test()
    } catch (error) {
      failed = true
      logFail(error.message)
    }
  }

  if (failed) process.exit(1)
  console.log('All novel-writer regressions passed.')
}

main()
