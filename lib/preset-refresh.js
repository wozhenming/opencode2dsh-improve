/**
 * Refresh the `preset-standard` snapshot in a DSH profile's cordis.patch.yml.
 *
 * DSH mounts its native condensation inside `preset-standard`'s nested
 * `compaction` group, and the patch engine replaces a matched row's `config`
 * WHOLESALE — there is no by-id deep merge. This plugin therefore ships a full
 * snapshot of the preset with `auto: false` on compaction-basic and the manual
 * /compact disabled. After any DSH upgrade the shipped roster can change, so the
 * snapshot must be re-copied (e.g. the 2026-10-18 update dropped `{{cwd}}` from
 * the persona suffix). This module re-extracts it from the running app and
 * re-applies the two edits — the engine behind the "Check for updates" button.
 *
 * @module opencode2dsh-improve/preset-refresh
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The asar-embedded file that declares the shipped `standard` preset. */
const PRESET_FILE = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
/** The snapshot comment marker our block starts with, used to locate it. */
const SNAPSHOT_MARKER = '# #2474'

/**
 * The profile this plugin runs in, derived from the module's own path
 * (`.../.dsh/profiles/<name>/node_modules/opencode2dsh-improve/...`). Most
 * reliable: the profile patch never contains the plugin's own row — that lives
 * in the plugin's bundle patch — so scanning for a plugin row misses it.
 */
function profileFromModule() {
  const url = typeof import.meta.url === 'string' ? import.meta.url : ''
  const m = url.match(/profiles[\\/]([^\\/]+)[\\/]node_modules/)
  return m ? decodeURIComponent(m[1]) : undefined
}

/**
 * The plugin's `cordis.patch.yml` in this profile: prefer the running profile,
 * then the hinted profile, then any profile whose patch carries our footprint
 * (the snapshot marker or the opencode2dsh provider). Returns null when none.
 */
function findPatchFile(dshHome, profileHint) {
  const profilesDir = path.join(dshHome, 'profiles')
  let entries = []
  try { entries = fs.readdirSync(profilesDir, { withFileTypes: true }) } catch { return null }
  const running = profileFromModule()
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(profilesDir, entry.name, 'cordis.patch.yml')
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    const isOurs = text.includes(SNAPSHOT_MARKER) || text.includes('provider: opencode2dsh')
    if (!isOurs && entry.name !== running && entry.name !== profileHint) continue
    const score = (entry.name === running ? 3 : 0) + (entry.name === profileHint ? 2 : 0) + (isOurs ? 1 : 0)
    candidates.push({ file, profile: entry.name, score })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]
}

/**
 * The raw, unpatched fs. Electron's asar-aware fs throws `ENOENT, not found in
 * <archive>` on `openSync` of the archive file itself, so the manual asar
 * parsing fallback must read the archive through the built-in module. Plain
 * Node (no `process.getBuiltinModule`) falls back to the imported `fs`.
 */
function rawFs() {
  if (typeof process.getBuiltinModule === 'function') {
    try {
      const builtin = process.getBuiltinModule('fs')
      if (builtin && typeof builtin.openSync === 'function') return builtin
    } catch { /* not available */ }
  }
  return fs
}

/**
 * Extract one file from the running app's asar.
 *
 * Under Electron the patched fs treats `<asar>/<inner path>` as a readable
 * file (the host itself loads its modules that way), so that is attempted
 * first. The manual archive parse is the fallback for plain Node, where the
 * patched fs does not exist.
 */
function extractFromAsar(asarPath, wanted) {
  try {
    const text = fs.readFileSync(`${asarPath}/${wanted}`, 'utf8')
    return text
  } catch { /* Electron patched fs unavailable or path differs */ }
  const fsm = rawFs()
  const fd = fsm.openSync(asarPath, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    fsm.readSync(fd, sizeBuf, 0, 8, 0)
    const headerSize = sizeBuf.readUInt32LE(4)
    const headerBuf = Buffer.alloc(headerSize)
    fsm.readSync(fd, headerBuf, 0, headerSize, 8)
    const headerJsonSize = headerBuf.readUInt32LE(4)
    const header = JSON.parse(headerBuf.slice(8, 8 + headerJsonSize).toString('utf8'))
    const dataStart = 8 + headerSize
    let found
    const walk = (node, base) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const full = base ? `${base}/${name}` : name
        if (entry.files) walk(entry, full)
        else if (full === wanted) found = entry
      }
    }
    walk(header, '')
    if (!found) return null
    const buf = Buffer.alloc(found.size)
    fsm.readSync(fd, buf, 0, found.size, dataStart + Number(found.offset))
    return buf.toString('utf8')
  } finally {
    fsm.closeSync(fd)
  }
}

/**
 * Where the running app keeps its asar. The host is Electron, so
 * `process.resourcesPath` is the `resources` directory; a handful of fallbacks
 * cover non-Electron hosts and unusual layouts.
 */
function candidateAsarPaths() {
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    candidates.push(path.join(process.resourcesPath, 'app.asar'))
  }
  if (typeof process.execPath === 'string' && process.execPath.length > 0) {
    candidates.push(path.join(path.dirname(process.execPath), 'resources', 'app.asar'))
    candidates.push(path.join(path.dirname(process.execPath), 'app.asar'))
  }
  candidates.push('C:/Users/HERRYCHEN/AppData/Local/Programs/DeepSeek Harness/resources/app.asar')
  return candidates.filter(p => p.length > 0)
}

/** Build the snapshot block (comment header + preset-standard declaration). */
function buildSnapshot(presetSource) {
  const lines = presetSource.split(/\r?\n/)
  const start = lines.findIndex(l => l.startsWith('    - id: preset-standard'))
  if (start < 0) return null
  const block = lines.slice(start)
    .filter(l => l.trim() !== '' || l.trimEnd() === '|' || l.includes('|'))
    .map(l => (l.startsWith('    ') ? l.slice(4) : l))
  const out = []
  for (const [i, line] of block.entries()) {
    out.push(line)
    const prev = block[i - 1] ?? ''
    const indent = ' '.repeat(line.length - line.trimStart().length)
    if (/name: '@deepseek-ai\/dsh-compaction-basic'/.test(line) && prev.trim() === '- id: compaction-basic') {
      out.push(`${indent}config:`)
      out.push(`${indent}  auto: false`)
    }
    if (/name: '@deepseek-ai\/dsh-command-compact'/.test(line) && prev.trim() === '- id: command-compact') {
      out.push(`${indent}disabled: true`)
    }
  }
  const header = [
    '# #2474: keep billion-context as the only compressor for this profile.',
    '#',
    '# DSH mounts its native condensation inside preset-standard\'s nested `compaction`',
    '# cordis:group, so no patch layer can reach it by id. This entry is a full',
    '# snapshot of the preset, copied from dsh-web-app/presets/standard.patch.yml.',
    '# Auto-refreshed by the plugin\'s "Check for updates" action after DSH',
    '# upgrades, with `auto: false` on the nested compaction-basic row and the',
    '# manual /compact command disabled. Do not edit by hand.',
  ]
  return [...header, ...out].join('\n')
}

/**
 * Re-copy the preset-standard snapshot.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun] report only, do not write
 * @param {string} [options.profileHint] prefer this profile's patch
 * @param {string} [options.dshHome] override the DSH home (tests)
 * @param {string} [options.asar] override the app.asar path (tests)
 * @returns {Promise<object>} {ok, changed, profile, patchFile, removed, added, error?}
 */
export async function refreshPreset(options = {}) {
  const dryRun = options.dryRun === true
  const dshHome = options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const asar = options.asar || candidateAsarPaths().find(p => fs.existsSync(p))

  try {
    if (!asar || !fs.existsSync(asar)) {
      return { ok: false, error: `找不到 app.asar（请指定路径）。已扫描：${candidateAsarPaths().join('; ')}` }
    }
    const source = extractFromAsar(asar, PRESET_FILE)
    if (source === null) {
      return { ok: false, error: `无法从 ${asar} 中提取 ${PRESET_FILE}` }
    }
    const newSnapshot = buildSnapshot(source)
    if (newSnapshot === null) {
      return { ok: false, error: '未在预设文件中找到 preset-standard 声明' }
    }
    const located = findPatchFile(dshHome, options.profileHint ?? '')
    if (located === null) {
      return { ok: false, error: `没有在 ${path.join(dshHome, 'profiles')} 下找到本插件的 cordis.patch.yml` }
    }
    const patchFile = located.file
    const current = fs.readFileSync(patchFile, 'utf8').split(/\r?\n/)
    const headerStart = current.findIndex(l => l.startsWith(SNAPSHOT_MARKER))
    let headEnd, tailStart
    if (headerStart === -1) {
      const firstEntry = current.findIndex(l => /^- id: /.test(l))
      headEnd = firstEntry === -1 ? current.length : firstEntry
      tailStart = headEnd
    } else {
      headEnd = headerStart
      tailStart = current.findIndex((l, i) => i > headerStart && /^- id: /.test(l) && !/^- id: preset-standard/.test(l))
      if (tailStart === -1) tailStart = current.length
    }
    const head = current.slice(0, headEnd).join('\n').replace(/\s+$/, '')
    const tail = current.slice(tailStart).join('\n').replace(/\s+$/, '')
    const next = `${head}\n\n${newSnapshot}\n\n${tail}\n`
    const removed = headerStart === -1 ? 0 : tailStart - headerStart
    const added = newSnapshot.split('\n').length

    const changed = fs.readFileSync(patchFile, 'utf8') !== next
    if (changed && !dryRun) {
      fs.writeFileSync(patchFile, next)
    }
    return {
      ok: true,
      changed,
      profile: located.profile,
      patchFile,
      removed,
      added,
      written: changed && !dryRun,
      asar,
    }
  } catch (error) {
    // Any fs/host quirk becomes a diagnosable message instead of a bare ENOENT.
    return {
      ok: false,
      error: `${error instanceof Error ? error.message : String(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      asar,
      dshHome,
    }
  }
}