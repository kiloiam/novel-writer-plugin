#!/usr/bin/env node
/**
 * project-lock.js — 项目级互斥锁（进程指纹 + 心跳租约）
 *
 * 所有高风险操作（删除、保存、重编号、恢复、导入）共用同一把锁。
 * 保证同一时刻只有一个高风险操作在修改项目文件。
 *
 * 用法（模块方式）：
 *   const { acquireLock } = require('./project-lock')
 *   const release = acquireLock(projectDir, 'delete-chapter')
 *   try { ... } finally { release() }
 *
 * 锁文件：<projectDir>/.novel-writer.lock
 * 心跳文件：<projectDir>/.novel-writer.lock.hb
 * 锁格式：JSON { pid, op, ts, nonce, fingerprint }（只写一次，不重写）
 * 心跳：独立 .hb 文件，只更新 mtime（utimesSync），消除 JSON 损坏风险
 *
 * 防死锁机制：
 *   1. 进程指纹：记录 startTime/ppid/execPath，回收锁时比对真实进程信息
 *      → 解决 PID 复用误判
 *   2. 心跳租约：持锁期间每 HEARTBEAT_INTERVAL_MS 刷新 .hb 文件 mtime
 *      → 故障窗口从分钟级压缩到秒级，且不重写主锁 JSON
 *   3. STALE_MS 兜底：超时强制回收
 *   4. nonce 验证：cleanup 时防止误删他人锁
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const LOCK_NAME = '.novel-writer.lock'
const HB_NAME = '.novel-writer.lock.hb'    // 独立心跳文件
const STALE_MS = 2 * 60 * 1000          // 2 分钟兜底超时
const CORRUPT_LOCK_GRACE_MS = 8 * 1000    // 主锁损坏且无活跃心跳时的快速失效窗口
const LEASE_DURATION_MS = 30 * 1000      // 租约有效期 30 秒（容忍 OneDrive/iCloud 等云盘 mtime 同步延迟）
const HEARTBEAT_INTERVAL_MS = 5 * 1000   // 心跳间隔 5 秒

// ── 进程指纹采集 ─────────────────────────────────────────

/**
 * 获取当前进程的指纹信息
 */
function getOwnFingerprint() {
  return {
    pid: process.pid,
    ppid: process.ppid || 0,
    execPath: process.execPath,
    script: process.argv[1] || '',
    startTime: _getProcessStartTime(process.pid),
  }
}

/**
 * 获取指定 PID 的进程启动时间（跨平台）
 * @returns {number|null} 启动时间戳(ms)或 null
 */
function _getProcessStartTime(pid) {
  try {
    if (process.platform === 'win32') {
      // Windows: PowerShell 获取进程启动时间（FileTimeUtc，跨重启唯一）
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToFileTimeUtc()`
      ], { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
      const ts = Number(out)
      if (!isNaN(ts) && ts > 0) return ts
    } else {
      // Linux: /proc/<pid>/stat field 22 = starttime (clock ticks since boot)
      const procStat = path.join('/proc', String(pid), 'stat')
      if (fs.existsSync(procStat)) {
        const stat = fs.readFileSync(procStat, 'utf8')
        // 跳过 comm 字段（可能含空格和括号）
        const afterComm = stat.replace(/^.*\)\s*/, '')
        const fields = afterComm.split(/\s+/)
        // field 22 在 afterComm 中是 index 19 (0-based, 因为跳过了 pid, comm, state 的 state 是 index 0)
        const starttime = Number(fields[19])
        if (!isNaN(starttime)) return starttime // 返回 ticks，用于比较即可
      }
      // macOS/其他 Unix: ps -p <pid> -o lstart=
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
      }).trim()
      if (out) {
        const d = new Date(out)
        if (!isNaN(d.getTime())) return d.getTime()
      }
    }
  } catch (_) {
    // 进程信息不可获取（权限不足、进程已死等）
  }
  return null
}

/**
 * 获取指定 PID 的 execPath（跨平台）
 * @returns {{ path: string, full: boolean }|null}
 *   path: 可执行路径
 *   full: true=完整绝对路径（可信比对），false=仅 basename/comm（只能做 basename 级匹配）
 */
function _getProcessExecPath(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`
      ], { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
      if (out) return { path: out, full: true }
    } else {
      // Linux: /proc/<pid>/exe — 返回完整绝对路径
      const exeLink = path.join('/proc', String(pid), 'exe')
      try {
        const resolved = fs.readlinkSync(exeLink)
        if (resolved) return { path: resolved, full: true }
      } catch (_) { /* /proc 不可用或权限不足 */ }
      // macOS / fallback: ps -o comm= — 只返回 basename，不可用于完整路径比对
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
        encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
      }).trim()
      if (out) return { path: out, full: false }
    }
  } catch (_) {}
  return null
}

// ── nonce 生成 ──────────────────────────────────────────

function generateNonce() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// ── 心跳定时器 ──────────────────────────────────────────
// 心跳只更新独立的 .hb 文件的 mtime，不再重写主锁 JSON。
// 这彻底消除了心跳写入期间被 kill 导致主锁 JSON 损坏的风险。

function _startHeartbeat(lockPath, hbPath, nonce) {
  // 初始创建 heartbeat 文件
  try { fs.writeFileSync(hbPath, nonce, 'utf8') } catch (_) {}

  const timer = setInterval(() => {
    try {
      // 验证主锁 nonce 仍然是自己的
      const raw = fs.readFileSync(lockPath, 'utf8')
      const info = JSON.parse(raw)
      if (info.nonce !== nonce) {
        clearInterval(timer)
        return
      }
      // 只更新 heartbeat 文件的 mtime（不重写任何 JSON）
      const now = new Date()
      fs.utimesSync(hbPath, now, now)
    } catch (_) {
      clearInterval(timer)
    }
  }, HEARTBEAT_INTERVAL_MS)

  if (timer.unref) timer.unref()
  return timer
}

// ── 进程指纹比对 ─────────────────────────────────────────

/**
 * 判断锁文件中记录的进程是否确实仍在运行
 *
 * 核心原则：**只有正面证据才能判定 reused**
 * - startTime 不同 → reused（最可靠）
 * - 两个完整路径不同 → reused（可靠）
 * - 信息不足（拿不到 startTime / 只拿到 basename）→ alive（保守）
 *
 * 宁可让一个过期锁多活几秒（等心跳/STALE_MS 超时回收），
 * 也不能误删一个活锁导致并发写入。
 *
 * @returns {'alive'|'dead'|'reused'}
 */
function _checkLockHolder(info) {
  if (!info.pid) return 'dead'

  // 先检查 PID 是否存活
  if (!_isProcessAlive(info.pid)) return 'dead'

  // PID 存活 — 检查是否是同一个进程（指纹比对）
  const fp = info.fingerprint
  if (!fp) {
    // 旧版锁文件无指纹信息，只能依赖超时
    return 'alive'
  }

  // ── 判据 1：启动时间（最可靠的 PID 复用检测手段）──
  // 只有当双方都有值且不相等时才判定 reused
  if (fp.startTime != null) {
    const currentStartTime = _getProcessStartTime(info.pid)
    if (currentStartTime != null) {
      if (currentStartTime !== fp.startTime) {
        return 'reused'  // 正面证据：同 PID 不同启动时间
      }
      // startTime 匹配 → 确认是同一个进程，直接返回
      return 'alive'
    }
    // currentStartTime 为 null → 拿不到信息，不做判断，继续检查下一项
  }

  // ── 判据 2：可执行路径（辅助判据，必须双向可比）──
  if (fp.execPath) {
    const current = _getProcessExecPath(info.pid)
    if (current != null) {
      if (current.full) {
        // 当前拿到完整路径：可以和锁文件里的完整路径直接比
        if (_normalizePath(current.path) !== _normalizePath(fp.execPath)) {
          return 'reused'  // 正面证据：完整路径不同
        }
      } else {
        // 当前只拿到 basename（如 "node"）：
        // 只要 basename 一致就不能判定 reused
        // basename 不一致才是正面证据
        const currentBase = path.basename(current.path).toLowerCase()
        const fpBase = path.basename(fp.execPath).toLowerCase()
        if (currentBase !== fpBase) {
          return 'reused'  // 正面证据：连 basename 都不同
        }
        // basename 一致但完整路径未知 → 信息不足，保守认为 alive
      }
    }
    // current 为 null → 完全拿不到信息，不做判断
  }

  // 所有判据都无法给出正面的"已复用"证据 → 保守认为 alive
  return 'alive'
}

function _normalizePath(p) {
  return p ? p.replace(/\\/g, '/').toLowerCase() : ''
}

// ── 过期/孤儿锁回收 ─────────────────────────────────────

/**
 * 检测并回收过期/孤儿锁
 *
 * 回收判据优先级：
 *   1. STALE_MS 兜底超时（优先用心跳 mtime，无心跳时用锁创建时间）→ 无条件回收
 *   2. 进程指纹不匹配（正面证据证明 PID 被复用）→ 回收
 *   3. 进程已死（kill(pid,0) 失败）→ 回收
 *   4. 心跳租约过期（进程可能活着但心跳停了）→ 回收
 *
 * 注意：指纹检查在心跳之前，因为指纹不匹配是确定性的，
 * 而心跳停止可能是暂时的（GC pause 等）。
 *
 * @returns {boolean} 是否成功回收
 */
function _tryReclaimStaleLock(lockPath) {
  const hbPath = lockPath.replace(/\.lock$/, '.lock.hb')
  try {
    const raw = fs.readFileSync(lockPath, 'utf8')
    const info = JSON.parse(raw)

    // 1. 超过 STALE_MS → 基于心跳或锁创建时间的兜底回收
    //    优先用心跳文件 mtime（更准确），心跳不存在时用锁创建时间
    let hbMtimeMs = null
    try {
      hbMtimeMs = fs.statSync(hbPath).mtimeMs
    } catch (_) { /* .hb 不存在 */ }
    const lastAliveMs = hbMtimeMs != null ? hbMtimeMs : info.ts
    if (Date.now() - lastAliveMs > STALE_MS) {
      fs.unlinkSync(lockPath)
      try { fs.unlinkSync(hbPath) } catch (_) {}
      return true
    }

    // 2. 进程指纹检查（确定性判据，优先于心跳超时）
    const holderStatus = _checkLockHolder(info)
    if (holderStatus === 'dead' || holderStatus === 'reused') {
      fs.unlinkSync(lockPath)
      try { fs.unlinkSync(hbPath) } catch (_) {}
      return true
    }

    // 3. 心跳租约过期（进程可能活着但心跳停了，如事件循环饥饿）
    if (hbMtimeMs != null && Date.now() - hbMtimeMs > LEASE_DURATION_MS + 5000) {
      fs.unlinkSync(lockPath)
      try { fs.unlinkSync(hbPath) } catch (_) {}
      return true
    }

  } catch (e) {
    if (e.code !== 'ENOENT') {
      try {
        const stat = fs.statSync(lockPath)
        let hbMtimeMs = null
        try {
          hbMtimeMs = fs.statSync(hbPath).mtimeMs
        } catch (_) { /* .hb 不存在 */ }

        // 主锁损坏（常见于异常中断/同步盘冲突）时，不要机械等待完整 STALE_MS。
        // 若无心跳或心跳也已过期，则走较短的 CORRUPT_LOCK_GRACE_MS 快速失效窗口，
        // 避免用户在"明明没人操作"时长时间被假锁住。
        const now = Date.now()
        const noActiveHeartbeat = hbMtimeMs == null || now - hbMtimeMs > LEASE_DURATION_MS + 5000
        if (noActiveHeartbeat && now - stat.mtimeMs > CORRUPT_LOCK_GRACE_MS) {
          fs.unlinkSync(lockPath)
          try { fs.unlinkSync(hbPath) } catch (_) {}
          return true
        }

        if (now - stat.mtimeMs > STALE_MS) {
          fs.unlinkSync(lockPath)
          try { fs.unlinkSync(hbPath) } catch (_) {}
          return true
        }
      } catch (_) {}
    }
    return false
  }
  return false
}

function _isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function buildInheritedLockEnv(projectDir, lockInfo) {
  return {
    NOVEL_WRITER_LOCK_HELD: path.resolve(projectDir),
    NOVEL_WRITER_LOCK_PID: String(lockInfo.pid),
    NOVEL_WRITER_LOCK_NONCE: String(lockInfo.nonce),
  }
}

function readLockInfo(lockPath) {
  const raw = fs.readFileSync(lockPath, 'utf8')
  return JSON.parse(raw)
}

function buildInheritedLockEnvFromProject(projectDir, baseEnv = process.env) {
  const resolvedDir = path.resolve(projectDir)
  if (baseEnv.NOVEL_WRITER_LOCK_HELD && path.resolve(baseEnv.NOVEL_WRITER_LOCK_HELD) === resolvedDir && baseEnv.NOVEL_WRITER_LOCK_PID && baseEnv.NOVEL_WRITER_LOCK_NONCE) {
    return {
      ...baseEnv,
      NOVEL_WRITER_LOCK_HELD: resolvedDir,
      NOVEL_WRITER_LOCK_PID: String(baseEnv.NOVEL_WRITER_LOCK_PID),
      NOVEL_WRITER_LOCK_NONCE: String(baseEnv.NOVEL_WRITER_LOCK_NONCE),
    }
  }
  const lockInfo = readLockInfo(path.join(resolvedDir, LOCK_NAME))
  return {
    ...baseEnv,
    ...buildInheritedLockEnv(resolvedDir, lockInfo),
  }
}

function buildUniqueTempPath(basePath, suffix = '.tmp') {
  const random = Math.random().toString(36).slice(2, 8)
  return `${basePath}${suffix}.${process.pid}.${random}`
}

// ── 获取锁 ──────────────────────────────────────────────

/**
 * 尝试获取项目锁
 * @param {string} projectDir 项目目录
 * @param {string} opName    操作名（用于诊断）
 * @param {number} [retries=10]  重试次数（每次等 500ms）
 * @returns {function} release 函数，调用即释放锁
 * @throws 获取失败时抛出 Error
 */
function acquireLock(projectDir, opName, retries = 10) {
  const resolvedDir = path.resolve(projectDir)
  const lockPath = path.join(resolvedDir, LOCK_NAME)
  const hbPath = path.join(resolvedDir, HB_NAME)

  // 如果父进程已持有锁（通过环境变量传递），返回空操作
  if (process.env.NOVEL_WRITER_LOCK_HELD && path.resolve(process.env.NOVEL_WRITER_LOCK_HELD) === resolvedDir) {
    try {
      const inheritedPid = Number(process.env.NOVEL_WRITER_LOCK_PID)
      const inheritedNonce = process.env.NOVEL_WRITER_LOCK_NONCE || ''
      const info = readLockInfo(lockPath)
      if (
        inheritedPid > 0 &&
        inheritedNonce &&
        info.pid === inheritedPid &&
        info.nonce === inheritedNonce &&
        _checkLockHolder(info) === 'alive'
      ) {
        return function release() { /* 父进程负责释放 */ }
      }
    } catch (_) {
      // 继承证明无效，继续走正常加锁流程
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      const nonce = generateNonce()
      const now = Date.now()
      const lockInfo = {
        pid: process.pid,
        op: opName,
        ts: now,
        nonce,
        fingerprint: getOwnFingerprint(),
      }
      const payload = JSON.stringify(lockInfo)
      fs.writeSync(fd, payload)
      fs.closeSync(fd)

      // 启动心跳（独立 heartbeat 文件）
      const heartbeatTimer = _startHeartbeat(lockPath, hbPath, nonce)

      // 注册进程退出自动清理
      const cleanup = () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        try {
          const raw = fs.readFileSync(lockPath, 'utf8')
          const info = JSON.parse(raw)
          if (info.nonce === nonce) {
            fs.unlinkSync(lockPath)
            try { fs.unlinkSync(hbPath) } catch (_) {}
          }
        } catch (e) { /* gone or changed */ }
      }
      process.on('exit', cleanup)

      return function release() {
        cleanup()
        try { process.removeListener('exit', cleanup) } catch (e) { /* ok */ }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e

      // 锁已存在 — 检查是否过期或持有者已死亡/PID被复用
      const reclaimed = _tryReclaimStaleLock(lockPath)
      console.error('DEBUG_RECLAIMED=' + reclaimed + ' attempt=' + attempt)
      if (reclaimed) {
        attempt--  // 回收成功，不消耗重试次数
        continue
      }

      console.error('DEBUG_RETRY_PATH attempt=' + attempt + ' retries=' + retries)
      if (attempt < retries) {
        const waitMs = 500
        try {
          const sab = new SharedArrayBuffer(4)
          console.error('DEBUG_WAIT_ATOMICS=' + waitMs)
          Atomics.wait(new Int32Array(sab), 0, 0, waitMs)
        } catch (_) {
          // Atomics.wait 不可用（旧 Node 或限制环境）→ 用 spawnSync 等待
          try {
            require('child_process').spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${waitMs})`], { timeout: waitMs + 100 })
          } catch (_2) {
            // spawnSync 也失败 → 用更短的 spawnSync sleep 替代 busy-wait
            try {
              require('child_process').spawnSync('sleep', ['0.5'], { timeout: waitMs + 100 })
            } catch (_3) { /* 极端环境：放弃等待，直接重试 */ }
          }
        }
        continue
      }

      // 全部重试耗尽
      console.error('DEBUG_FINAL_THROW attempt=' + attempt)
      let holder = '另一进程仍持有项目锁'
      let lockLooksDamaged = false
      try {
        const raw = fs.readFileSync(lockPath, 'utf8')
        const info = JSON.parse(raw)
        holder = `${info.op} (PID ${info.pid})`
      } catch (e2) {
        try {
          const raw = fs.readFileSync(lockPath, 'utf8')
          const info = JSON.parse(raw)
          holder = `${info.op} (PID ${info.pid})`
        } catch (_) {
          lockLooksDamaged = true
          try {
            const stat = fs.statSync(lockPath)
            const hbStat = fs.existsSync(hbPath) ? fs.statSync(hbPath) : null
            const hbAge = hbStat ? Date.now() - hbStat.mtimeMs : null
            const age = Date.now() - stat.mtimeMs
            holder = hbAge == null
              ? `锁文件损坏（无心跳，年龄 ${age}ms）`
              : `锁文件损坏（心跳年龄 ${Math.round(hbAge)}ms，锁年龄 ${Math.round(age)}ms）`
          } catch (_) {
            holder = '锁文件损坏'
          }
        }
      }
      console.error('DEBUG_FINAL_HOLDER=' + holder)
      console.error('DEBUG_FINAL_DAMAGED=' + lockLooksDamaged)
      const detail = lockLooksDamaged
        ? `${holder}。这通常是异常中断或同步盘冲突导致的损坏锁；可稍后重试，如确认无其他操作在执行，可手动删除 ${lockPath}`
        : `${holder}。可稍后重试，或等待持锁操作完成。`
      throw new Error(`项目锁被占用: ${detail}`)
    }
  }

  // 理论上不应到达此处（循环内要么 return 要么 throw），防御性兜底
  throw new Error(`项目锁获取失败（内部错误）。如确认无其他操作在执行，可手动删除 ${lockPath}`)
}

module.exports = { acquireLock, buildInheritedLockEnvFromProject, buildUniqueTempPath }
