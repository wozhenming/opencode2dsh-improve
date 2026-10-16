/**
 * Live streaming support for the loopback shim.
 *
 * The runtime delivers a turn incrementally on its event stream: reasoning and
 * text arrive as `message.part.delta` frames plus cumulative `part.updated`
 * snapshots. Tool calls only become trustworthy once the envelope has been
 * decoded and validated, so they stay buffered to the end. This module turns
 * the live frames into OpenAI streaming chunks — reasoning as
 * `reasoning_content`, and, while a text-channel envelope is still being
 * written, the growing value of its `content` field.
 *
 * @module dsh-opencode-xdbridge/stream
 */

import { randomBytes } from 'node:crypto'
import { sendSSE, pseudoToolCallIndex, pseudoToolCallPartial } from './protocol.js'

/**
 * Decode a JSON string literal that starts at `start` (the opening quote).
 * `end` is the index just past the closing quote, or the end of the buffer
 * when the literal is still incomplete.
 */
function readJsonString(raw, start) {
  let out = ''
  let i = start + 1
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\\') {
      const next = raw[i + 1]
      if (next === undefined) return { value: out, closed: false, end: raw.length }
      if (next === 'u') {
        const hex = raw.slice(i + 2, i + 6)
        if (hex.length < 4 || /[^0-9a-fA-F]/.test(hex)) return { value: out, closed: false, end: raw.length }
        out += String.fromCharCode(parseInt(hex, 16))
        i += 6
        continue
      }
      const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
      out += escapes[next] ?? next
      i += 2
      continue
    }
    if (ch === '"') return { value: out, closed: true, end: i + 1 }
    out += ch
    i++
  }
  return { value: out, closed: false, end: raw.length }
}

function skipWhitespace(raw, from) {
  let i = from
  while (i < raw.length && /\s/.test(raw[i])) i++
  return i
}

/**
 * Locate the top-level `content` string of a partially received envelope and
 * decode as much of it as the buffer holds. Only keys of the root object
 * count, so nested strings never match; a string token is recognised as a key
 * by the `:` that follows it.
 *
 * @returns {{text: string|null, complete: boolean}} `text` is null while the
 *   field has not been seen yet or the value is not a string.
 */
function scanContent(raw) {
  let depth = 0
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '"') {
      const token = readJsonString(raw, i)
      if (!token.closed) return { text: null, complete: false }
      const after = skipWhitespace(raw, token.end)
      if (raw[after] === ':') {
        if (depth === 1 && token.value === 'content') {
          const valueStart = skipWhitespace(raw, after + 1)
          if (raw[valueStart] !== '"') return { text: null, complete: false }
          const value = readJsonString(raw, valueStart)
          return { text: value.value, complete: value.closed }
        }
        i = after + 1
        continue
      }
      i = token.end
      continue
    }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth <= 0) return { text: null, complete: false }
    }
    i++
  }
  return { text: null, complete: false }
}

/**
 * Streaming reader for one envelope's `content` field.
 *
 * `push` accepts raw text chunks and returns the newly decoded characters of
 * the value; short of a closed string it keeps asking for more. `resume`
 * keeps everything already emitted and starts scanning a new envelope, which
 * is what a correction retry produces.
 */
export class EnvelopeContentStream {
  constructor() {
    this.raw = ''
    this.emitted = 0
    this.done = false
    this.frozen = false
  }

  resume() {
    this.raw = ''
    this.done = false
    this.frozen = false
  }

  push(chunk) {
    if (this.done || typeof chunk !== 'string' || chunk.length === 0) return ''
    this.raw += chunk
    const { text, complete } = scanContent(this.raw)
    if (complete) this.done = true
    if (text === null || text.length <= this.emitted) return ''
    // A model that writes tool calls as markup is about to produce text we
    // cannot validate, so nothing from the marker on is forwarded: the
    // validated message arrives at `finish` and the client shows that instead.
    if (!this.frozen && pseudoToolCallIndex(text.slice(this.emitted)) !== -1) this.frozen = true
    if (this.frozen) return ''
    // A marker can straddle two chunks, so a tail that could still grow into
    // one waits for the next chunk rather than being forwarded as text.
    let limit = text.length
    if (!complete && pseudoToolCallPartial(text)) {
      const partial = /<\u200b?[ \t]*(?:[A-Za-z_]{0,12})$/.exec(text)
      if (partial) limit = partial.index
    }
    if (limit <= this.emitted) return ''
    const out = text.slice(this.emitted, limit)
    this.emitted = limit
    return out
  }
}

/**
 * Bridge one streaming request to OpenAI SSE chunks.
 *
 * Reasoning is forwarded verbatim as `reasoning_content`. Plain chat turns
 * forward text directly; envelope turns extract the `content` field as the
 * model writes it. When the validated completion arrives, only the part not
 * streamed yet is emitted, followed by tool calls, the finish reason and
 * usage — so an envelope that never produced trustworthy content still shows
 * up whole, exactly as the buffered path used to.
 */
export function createSseStream(res, body, request, warn) {
  const id = `chatcmpl-${randomBytes(16).toString('hex')}`
  const created = Math.floor(Date.now() / 1000)
  const envelope = request.chatOnly ? null : new EnvelopeContentStream()
  let roleSent = false
  let contentSent = ''

  const write = (delta, finishReason = null) => {
    if (res.destroyed || res.writableEnded) return
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`)
  }
  const ensureRole = () => {
    if (roleSent) return
    roleSent = true
    write({ role: 'assistant' })
  }
  const emitContent = (text) => {
    if (!text) return
    contentSent += text
    ensureRole()
    write({ content: text })
  }

  return {
    event(update) {
      if (res.destroyed || res.writableEnded) return
      if (update?.kind === 'reasoning' && update.delta) {
        ensureRole()
        write({ reasoning_content: update.delta })
        return
      }
      if (update?.kind === 'text' && update.delta) {
        emitContent(envelope ? envelope.push(update.delta) : update.delta)
      }
    },
    correcting() {
      envelope?.resume()
    },
    finish(result, includeUsage) {
      const message = result.choices?.[0]?.message
      const authoritative = typeof message?.content === 'string' ? message.content : ''
      if (authoritative) {
        let pending = ''
        if (authoritative !== contentSent) {
          if (authoritative.startsWith(contentSent)) {
            pending = authoritative.slice(contentSent.length)
          } else {
            warn?.(`流式内容与最终结果不一致（已流式 ${contentSent.length} 字符），整段补发`)
            pending = authoritative
          }
        }
        message.content = pending
      }
      Object.assign(result, { id, created })
      sendSSE(res, result, includeUsage, roleSent)
    },
  }
}
