#!/usr/bin/env node
/**
 * Refresh the `preset-standard` snapshot in a DSH profile's cordis.patch.yml.
 *
 * DSH mounts its native condensation inside `preset-standard`'s nested
 * `compaction` group, and the patch engine replaces a matched row's `config`
 * WHOLESALE — there is no by-id deep merge (the plugin's own docs say so). So
 * this fork ships a full snapshot of the preset with `auto: false` on
 * compaction-basic and the manual /compact disabled. After any DSH upgrade the
 * shipped roster can change (e.g. it dropped `{{cwd}}` from the persona suffix
 * in the 2026-10-18 update), so the snapshot must be re-copied. This script
 * re-extracts it from the app and re-applies the two edits.
 *
 * Usage:
 *   node scripts/refresh-preset.mjs                  # default: profile "desktop"
 *   node scripts/refresh-preset.mjs --profile web
 *   node scripts/refresh-preset.mjs --asar "C:/.../resources/app.asar"
 *   node scripts/refresh-preset.mjs --dry-run        # report only, no write
 *
 * Exit code 0 = up to date or refreshed; 1 = could not find/parse the pieces.
 * Prints the diff stat; a DSH upgrade that changed the roster will show up as
 * a non-empty change here.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? def : args[i + 1]
}
const hasFlag = (name) => args.includes(`--${name}`)

const profile = flag('profile', 'desktop')
const dryRun = hasFlag('dry-run')
const printOnly = hasFlag('print')
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const patchFile = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml')
const asar = flag('asar', 'C:/Users/HERRYCHEN/AppData/Local/Programs/DeepSeek Harness/resources/app.asar')

if (!fs.existsSync(patchFile)) {
  console.error(`profile patch not found: ${patchFile}`)
  process.exit(1)
}
if (!fs.existsSync(asar)) {
  console.error(`app.asar not found: ${asar} (pass --asar)`)
  process.exit(1)
}

/** Extract one file from an asar archive. */
function extractFromAsar(asarPath, wanted) {
  const fd = fs.openSync(asarPath, 'r')
  const sizeBuf = Buffer.alloc(8)
  fs.readSync(fd, sizeBuf, 0, 8, 0)
  const headerSize = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  fs.readSync(fd, headerBuf, 0, headerSize, 8)
  const headerJsonSize = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.slice(8, 8 + headerJsonSize).toString('utf8'))
  const dataStart = 8 + headerSize
  let found = undefined
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
  fs.readSync(fd, buf, 0, found.size, dataStart + Number(found.offset))
  fs.closeSync(fd)
  return buf.toString('utf8')
}

const presetFile = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
const src = extractFromAsar(asar, presetFile)
if (src === null) {
  console.error(`could not extract ${presetFile} from ${asar}`)
  process.exit(1)
}

// Take the `- id: preset-standard` block and lift it to profile-patch level.
const lines = src.split(/\r?\n/)
const start = lines.findIndex(l => l.startsWith('    - id: preset-standard'))
if (start < 0) {
  console.error('preset-standard declaration not found in the preset file')
  process.exit(1)
}
const block = lines.slice(start)
  .filter(l => l.trim() !== '' || l.trimEnd() === '|' || l.includes('|'))
  .map(l => (l.startsWith('    ') ? l.slice(4) : l))

// Re-apply the two compaction edits, indentation-aware.
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
  '# Auto-refreshed by scripts/refresh-preset.mjs after DSH upgrades, with',
  '# `auto: false` on the nested compaction-basic row and the manual /compact',
  '# command disabled. Do not edit by hand.',
]

const newSnapshot = [...header, ...out].join('\n')

// Replace the old snapshot block (from the `# #2474` header to the next
// top-level entry), or insert before the first top-level entry if absent.
const current = fs.readFileSync(patchFile, 'utf8').split(/\r?\n/)
const headerStart = current.findIndex(l => l.startsWith('# #2474'))
let headEnd, tailStart
if (headerStart === -1) {
  const firstEntry = current.findIndex(l => /^- id: /.test(l))
  headEnd = firstEntry === -1 ? current.length : firstEntry
  tailStart = firstEntry === -1 ? current.length : firstEntry
} else {
  headEnd = headerStart
  // The first `- id: ` after the comment header is `preset-standard` itself;
  // the snapshot ends at the NEXT top-level entry (e.g. opencode2dsh-improve).
  tailStart = current.findIndex((l, i) => i > headerStart && /^- id: /.test(l) && !/^- id: preset-standard/.test(l))
  if (tailStart === -1) tailStart = current.length
}
const head = current.slice(0, headEnd).join('\n').replace(/\s+$/, '')
const tail = current.slice(tailStart).join('\n').replace(/\s+$/, '')

const before = fs.readFileSync(patchFile, 'utf8')
const next = `${head}\n\n${newSnapshot}\n\n${tail}\n`
if (printOnly) {
  process.stdout.write(next)
  process.exit(0)
}
const changed = before !== next
const removed = headerStart === -1 ? 0 : tailStart - headerStart
const added = newSnapshot.split('\n').length + 2

console.log(`profile: ${profile}`)
console.log(`patch:   ${patchFile}`)
console.log(`preset:  ${presetFile}`)
console.log(`snapshot: ${removed} lines replaced by ${added} lines (${changed ? 'CHANGED' : 'unchanged'})`)
if (!changed) {
  console.log('up to date — the roster in the current DSH matches the snapshot.')
  process.exit(0)
}
if (dryRun) {
  console.log('(dry run — not written)')
  process.exit(0)
}
fs.writeFileSync(patchFile, next)
console.log('written. Restart DSH for the new preset to take effect.')
