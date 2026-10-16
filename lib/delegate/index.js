/**
 * Delegated OpenCode runtime for the opencode2dsh plugin.
 *
 * The direct Zen lane this plugin shipped with became unusable: OpenCode Zen
 * refuses requests that do not originate from a genuine OpenCode runtime
 * (`FreeTierError: OpenCode's free tier can only be used from within OpenCode`).
 * This module therefore runs the vendor's own `opencode serve` inside an
 * isolated XDG root and exposes it over a loopback OpenAI-compatible endpoint
 * that the plugin's adapter talks to through pi-ai.
 *
 * The runtime/shim/protocol core is vendored from dsh-opencode-xdbridge (MIT).
 * This file is the orchestration layer: data directory, logging, credential
 * seeding, binary discovery, memory control and the lifecycle handle the
 * adapter consumes.
 *
 * @module opencode2dsh-improve/delegate
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findRuntime, startBackend } from './runtime.js'
import { createShim } from './shim.js'
import { BridgeCatalog } from './catalog.js'
import { dshHome, runtimePackage } from './platform.js'

const LOG_ROTATE_BYTES = 5 * 1024 * 1024
const STARTUP_REFRESH_MS = 15_000
const DEFAULT_REFRESH_MS = 10 * 60_000

/**
 * Strip the runtime's provider scope so the plugin's own model ids match.
 *
 * `prepare` accepts `model.id`, `model.name` and `OC · name`. The harness sends
 * the bare model id it advertised in its picker (`big-pickle`), which matches
 * neither `opencode/big-pickle` nor the runtime display name, so the entries
 * handed to the shim carry the bare id as their `name`.
 */
function bareModelID(id) {
  const prefix = 'opencode/'
  return typeof id === 'string' && id.startsWith(prefix) ? id.slice(prefix.length) : id
}

function visibleModels(catalog) {
  return catalog.visible().map(model => ({ ...model, name: bareModelID(model.id) }))
}

/** Log file for the managed runtime, rotated once at 5 MB. */
async function openLogStream(dataDir) {
  const file = path.join(dataDir, 'opencode.log')
  try {
    const stat = await fsp.stat(file)
    if (stat.size > LOG_ROTATE_BYTES) await fsp.rename(file, `${file}.previous`)
  } catch { /* no existing log */ }
  return fs.createWriteStream(file, { flags: 'a', mode: 0o600 })
}

/** The user's real OpenCode credential file, wherever this platform keeps it. */
function authCandidates() {
  const home = os.homedir()
  return [
    process.env.OPENCODE2DSH_AUTH_JSON,
    process.env.OPENCODE_AUTH_JSON,
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json') : undefined,
    path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    path.join(home, '.local', 'share', 'opencode', 'auth.jsonc'),
  ].filter(value => typeof value === 'string' && value.length > 0)
}

/**
 * Copy the host's Zen credentials into the isolated runtime.
 *
 * `startBackend` points the runtime's XDG_DATA_HOME at `<dataDir>/opencode/data`,
 * so `opencode/auth.json` below it is where the runtime looks first. Only the
 * `opencode` provider entry is carried over; unrelated provider keys never
 * leave the user's own store. Zen's anonymous free tier usually needs no
 * credential at all, so a miss is logged and tolerated.
 */
function seedAuth(dataDir, log) {
  const target = path.join(dataDir, 'opencode', 'data', 'opencode', 'auth.json')
  if (fs.existsSync(target)) return 'present'

  const source = authCandidates().find(file => fs.existsSync(file))
  if (source === undefined) {
    log('[delegate] 未找到 opencode auth.json；Zen 匿名免费层通常无需凭据，若遇 403 请先运行 opencode auth login')
    return 'missing'
  }

  try {
    const raw = JSON.parse(fs.readFileSync(source, 'utf8'))
    const zen = raw?.opencode
    if (!zen) {
      log(`[delegate] ${source} 中没有 opencode 条目；Zen 匿名免费层通常无需凭据`)
      return 'missing'
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify({ opencode: zen }), { mode: 0o600 })
    log(`[delegate] 已注入 Zen 凭据（${source}）`)
    return 'seeded'
  } catch (error) {
    log(`[delegate] 读取 ${source} 失败：${error.message}`)
    return 'error'
  }
}

/**
 * Where a usable `opencode` binary may already live.
 *
 * `findRuntime`'s built-in list knows the curl installer and the homebrew
 * paths but not the npm global prefix this machine uses (`nvm4w`), so the PATH
 * scan is required for automatic discovery. A previously managed runtime from
 * a sibling bridge install is reused rather than re-downloaded.
 */
function binaryCandidates(pkg, options) {
  const found = []
  const seen = new Set()
  const add = (file) => {
    if (typeof file !== 'string' || file.length === 0 || seen.has(file)) return
    seen.add(file)
    if (fs.existsSync(file)) found.push(file)
  }

  add(options.binaryPath)
  add(process.env.OPENCODE2DSH_OPENCODE_BINARY)
  add(process.env.OPENCODE_BINARY_PATH)
  add(path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'opencode-ai', 'bin', pkg.binary))
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    add(path.join(dir, 'node_modules', 'opencode-ai', 'bin', pkg.binary))
  }
  add(path.join(os.homedir(), '.opencode', 'bin', pkg.binary))

  const home = dshHome()
  for (const root of [
    path.join(home, 'opencode-xdbridge', 'runtime'),
    path.join(home, 'opencode2dsh', 'delegate', 'runtime'),
  ]) {
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { /* not present */ }
    for (const entry of entries) {
      if (entry.isDirectory()) add(path.join(root, entry.name, pkg.binary))
    }
  }
  return found
}

let trimmerLoader = null

/**
 * Release an OpenCode process's physical working set (Windows only).
 *
 * The runtime is a Go program: its heap is marked reclaimable but the pages
 * are not handed back to the OS, so the working set sits at a few hundred MB.
 * `EmptyWorkingSet` returns them (measured 419 MB -> 38 MB by opengate, which
 * this follows). koffi is used when present, PowerShell otherwise.
 */
async function loadTrimmer() {
  if (trimmerLoader !== null) return trimmerLoader
  trimmerLoader = (async () => {
    if (process.platform !== 'win32') return () => false
    if (process.env.OPENCODE2DSH_TRIM === '0') return () => false
    try {
      const { createRequire } = await import('node:module')
      const require = createRequire(import.meta.url)
      const koffi = require('koffi')
      const psapi = koffi.load('psapi.dll')
      const empty = psapi.func('bool EmptyWorkingSet(void* hProcess)')
      const kernel32 = koffi.load('kernel32.dll')
      const open = kernel32.func('void* OpenProcess(uint32, bool, uint32)')
      const close = kernel32.func('bool CloseHandle(void*)')
      return (pid) => {
        const handle = open(0x0100 | 0x0400, false, pid)
        if (!handle) return false
        try { return empty(handle) } finally { close(handle) }
      }
    } catch {
      const { execFile } = await import('node:child_process')
      return (pid) => {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `$s=Add-Type -Namespace W -Name M -MemberDefinition '[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);' -PassThru;`
          + `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p){$s::EmptyWorkingSet($p.Handle)|Out-Null}`,
        ], { windowsHide: true }, () => {})
        return true
      }
    }
  })()
  return trimmerLoader
}

/**
 * Start the delegated runtime and its loopback shim.
 *
 * Resolves only when the runtime is healthy and the shim is listening. The
 * returned handle is what the adapter's delegate branch reads: a base URL and
 * bearer token for the shim, plus refresh/model/stop controls.
 *
 * @param {object} [options]
 * @param {string} [options.dataDir]          managed-runtime data directory
 * @param {string} [options.binaryPath]       use this OpenCode binary
 * @param {string} [options.runtimeVersion]   pin a specific OpenCode version
 * @param {(message: string) => void} [options.log] log sink
 * @param {(message: string) => void} [options.status] progress sink (download, warm-up)
 * @returns {Promise<{
 *   version: string,
 *   baseUrl: () => string,
 *   token: () => string,
 *   refresh: () => Promise<number>,
 *   modelCount: () => number,
 *   stop: () => Promise<void>,
 * }>}
 */
export async function startDelegate(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const reportStatus = typeof options.status === 'function' ? options.status : () => {}
  const dataDir = options.dataDir || process.env.OPENCODE2DSH_DELEGATE_DIR || path.join(os.homedir(), '.opencode2dsh', 'delegate')
  const pkg = runtimePackage()

  await fsp.mkdir(dataDir, { recursive: true })
  const logStream = await openLogStream(dataDir)
  const writeLine = (message) => {
    try { logStream.write(`${new Date().toISOString()} ${message}\n`) } catch { /* stream closing */ }
  }
  /** Progress the plugin shows while the first request waits for the runtime. */
  const report = (message) => {
    reportStatus(message)
    log(`[delegate] ${message}`)
    writeLine(message)
  }

  let runtime
  let backend
  let shim
  let refreshTimer
  let startupRefreshTimer
  let trimmerTimer
  let stopped = false

  const release = async () => {
    stopped = true
    clearInterval(refreshTimer)
    clearTimeout(startupRefreshTimer)
    if (trimmerTimer) clearInterval(trimmerTimer)
    await shim?.close().catch(() => {})
    await runtime?.stop().catch(() => {})
    try { logStream.end() } catch { /* already closed */ }
  }

  try {
    const dbPath = path.join(dataDir, 'opencode', 'data', 'opencode', 'opencode.db')
    const freshInstall = !fs.existsSync(dbPath)

    report(fs.existsSync(path.join(dataDir, 'runtime'))
      ? '正在启动 OpenCode 运行时'
      : '首次启动：需要下载 OpenCode 运行时（约 60 MB，下载可断点续传）')
    const binary = await findRuntime(dataDir, report, {
      candidates: binaryCandidates(pkg, options),
      ...(options.runtimeVersion ? { version: options.runtimeVersion } : {}),
    })

    const authState = seedAuth(dataDir, writeLine)

    const startRuntime = async () => {
      runtime = await startBackend(binary, dataDir, logStream, {
        GOMEMLIMIT: process.env.OPENCODE2DSH_GOMEMLIMIT ?? '96MiB',
        GOGC: process.env.OPENCODE2DSH_GOGC ?? '30',
      })
      backend = runtime.backend
    }
    await startRuntime()
    report(`运行时 v${runtime.version} 已启动，正在读取免费模型清单`)

    const catalog = new BridgeCatalog()
    const refresh = async () => {
      const models = await backend.models()
      catalog.replace(models)
      return models.length
    }

    // Absorb the one-time refusal a virgin data directory gets from Zen
    // (verified 2026-10-15: both `opencode run` and `opencode serve` return
    // FreeTierError on the very first inference after installation, while the
    // next process start on the same data directory succeeds). The user's
    // first real request must never be the one that pays this cost, so a
    // disposable completion is sent here; if it hits the gate the runtime is
    // restarted once and the warm-up is repeated.
    const warmUp = async () => {
      const models = visibleModels(catalog)
      if (models.length === 0) return false
      const preferred = models.find(model => model.name === 'big-pickle') ?? models[0]
      try {
        const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
          body: JSON.stringify({
            model: preferred.name,
            stream: false,
            messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          }),
          signal: AbortSignal.timeout(90_000),
        })
        const text = await response.text()
        let parsed
        try { parsed = JSON.parse(text) } catch { /* non-JSON body */ }
        const ok = response.status === 200 && parsed !== undefined && parsed.error === undefined
        if (!ok) writeLine(`warm-up failed: HTTP ${response.status} ${text.slice(0, 300)}`)
        return ok
      } catch (error) {
        writeLine(`warm-up failed: ${error.message}`)
        return false
      }
    }

    shim = await createShim({
      complete: (request, signal, meta) => backend.complete(request, signal, meta),
      getModels: () => visibleModels(catalog),
      refresh,
      logger: {
        warn: (message) => { log(message); writeLine(message) },
        error: (message, error) => {
          const detail = error?.message ? `${message}: ${error.message}` : String(message)
          log(detail)
          writeLine(detail)
        },
      },
      dataDir,
    })

    let count = 0
    try {
      count = await refresh()
    } catch (error) {
      log(`[delegate] 免费模型清单读取失败（稍后重试）：${error.message}`)
      writeLine(`model catalog read failed: ${error.message}`)
    }

    if (freshInstall && process.env.OPENCODE2DSH_WARMUP !== '0') {
      report('正在预热：新数据目录的首次请求会被 Zen 一次性拒绝，需要自动重试一次')
      let warmed = await warmUp()
      if (!warmed) {
        log('[delegate] 新数据目录的首次请求被 Zen 一次性拒绝，重启运行时后重试')
        await runtime.stop().catch(() => {})
        runtime = undefined
        backend = undefined
        await startRuntime()
        try { count = await refresh() } catch { /* keep previous list */ }
        warmed = await warmUp()
      }
      log(warmed ? '[delegate] 预热完成，委托通道已可用' : '[delegate] 预热未成功；随后请求仍会按正常路径尝试')
      report(warmed ? '预热完成' : '预热未成功')
    }

    // The runtime's provider list occasionally settles late, and quota state
    // changes over a long session, so the roster is re-read shortly after
    // startup and then periodically. Failures keep the previous list.
    const refreshMs = Number(process.env.OPENCODE2DSH_REFRESH_MS ?? DEFAULT_REFRESH_MS)
    refreshTimer = setInterval(() => { refresh().catch(() => {}) }, refreshMs)
    refreshTimer.unref?.()
    startupRefreshTimer = setTimeout(() => { refresh().catch(() => {}) }, STARTUP_REFRESH_MS)
    startupRefreshTimer.unref?.()

    const trimmer = await loadTrimmer()
    if (trimmer !== null && runtime.child?.pid) {
      const pid = runtime.child.pid
      const intervalMs = Number(process.env.OPENCODE2DSH_TRIM_INTERVAL_MS ?? 60_000)
      const trim = () => { try { trimmer(pid) } catch { /* runtime may have exited */ } }
      trim()
      trimmerTimer = setInterval(trim, intervalMs)
      trimmerTimer.unref?.()
    }

    log(`[delegate] 独立 OpenCode 运行时已就绪：v${runtime.version}，pid=${runtime.child?.pid ?? '?'}，凭据=${authState}，免费模型=${count}`)
    report(`已就绪：${count} 个免费模型`)

    return {
      version: runtime.version,
      baseUrl: () => shim.baseUrl(),
      token: () => shim.token(),
      refresh,
      modelCount: () => catalog.visible().length,
      stop: async () => {
        if (stopped) return
        await release()
      },
    }
  } catch (error) {
    await release()
    throw error
  }
}
