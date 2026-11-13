// Agent Meter reader.
//
// Runs on the machine the coding agents run on. The plugin worker pipes this file to
// `node --input-type=module -` over SSH and reads one line back, so it must stay a
// single file that imports only Node built-ins. It keeps nothing between runs: every
// run looks at the session logs the agents already write, and bounds its own work
// (files touched in the period, the tail of large logs, a deadline).
//
// Nothing here prints message text. The result holds model names, token counts,
// durations and, for sessions Orca does not list, the working directory.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

/** The worker picks the result line by this prefix: a remote rc file may print too. */
export const SENTINEL = 'AGENT_METER_RESULT '

export const PERIODS = { '15m': 15 * 60_000, '1h': 60 * 60_000, '24h': 24 * 60 * 60_000 }

/** A response shorter than this says more about latency than about decode speed. */
export const MIN_TOKENS = 50
export const MIN_MS = 500

const TAIL_BYTES = 4 * 1024 * 1024
/** Enough for a rollout's first line (`session_meta`, about 20 KB). */
const HEAD_SMALL_BYTES = 64 * 1024
/** Enough to reach a rollout's first `turn_context`. */
const HEAD_LARGE_BYTES = 1024 * 1024
const DSH_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_BUDGET_MS = 4500
/** How far back a live agent's session is looked up for its context. */
const CONTEXT_LOOKBACK_MS = 7 * 24 * 60 * 60_000
const MAX_FILES_PER_SOURCE = 400
/** A DSH session written this recently is drawn as working. */
const DSH_WORKING_MS = 2 * 60_000

const CLAUDE_WINDOW = 200_000
const CLAUDE_WINDOW_1M = 1_000_000

// ---------------------------------------------------------------------------
// Small helpers

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ms(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/** Parsed objects of a JSONL text. A line that is not JSON is skipped: a log being
 *  appended to can end in half a line. */
export function* jsonLines(text, skip) {
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    if (end > start) {
      const line = text.slice(start, end)
      if (!skip || !skip(line)) {
        try {
          const value = JSON.parse(line)
          if (isRecord(value)) yield value
        } catch {
          // Not a whole record.
        }
      }
    }
    start = end + 1
  }
}

/** → `{ text, truncated }`. When the file is larger than `maxBytes` only its tail is
 *  read and the first, partial line is dropped. */
export function readTail(file, maxBytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const got = fs.readSync(fd, buffer, read, length - read, size - length + read)
      if (got === 0) break
      read += got
    }
    let text = buffer.toString('utf8', 0, read)
    const truncated = size > length
    if (truncated) {
      const newline = text.indexOf('\n')
      text = newline === -1 ? '' : text.slice(newline + 1)
    }
    return { text, truncated }
  } finally {
    fs.closeSync(fd)
  }
}

/** The first `maxBytes` of a file, cut back to whole lines. */
export function readHead(file, maxBytes = HEAD_LARGE_BYTES) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const got = fs.readSync(fd, buffer, read, length - read, read)
      if (got === 0) break
      read += got
    }
    let text = buffer.toString('utf8', 0, read)
    if (size > length) {
      const newline = text.lastIndexOf('\n')
      text = newline === -1 ? '' : text.slice(0, newline + 1)
    }
    return text
  } finally {
    fs.closeSync(fd)
  }
}

function statOrNull(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function realOrSelf(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/** Existing directories among `candidates`, one per real path: a profile's folder is
 *  often a symlink to the shared one. */
function uniqueDirs(candidates) {
  const seen = new Set()
  const dirs = []
  for (const candidate of candidates) {
    const stat = statOrNull(candidate)
    if (!stat || !stat.isDirectory()) continue
    const real = realOrSelf(candidate)
    if (seen.has(real)) continue
    seen.add(real)
    dirs.push(real)
  }
  return dirs
}

function isDirEntry(parent, entry) {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  const stat = statOrNull(path.join(parent, entry.name))
  return Boolean(stat && stat.isDirectory())
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** JSON with `//` and `/* *\/` comments and trailing commas, as config files allow. */
export function parseJsonc(text) {
  try {
    return JSON.parse(text)
  } catch {
    // Fall through to the comment-stripping pass.
  }
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === '\\') {
        index += 1
        out += text[index] ?? ''
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      out += '\n'
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 1
    } else {
      out += char
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return null
  }
}

export function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** One measured response: `tokens` generated over `ms`, finished at `at`. */
function sample(agent, model, tokens, durationMs, at, estimated) {
  return { agent, model: String(model || 'unknown'), tokens, ms: durationMs, at, estimated }
}

export function eligible(entry, since, now) {
  return (
    entry.tokens >= MIN_TOKENS &&
    entry.ms >= MIN_MS &&
    entry.at !== null &&
    entry.at >= since &&
    entry.at <= now + 60_000
  )
}

/** Per agent kind and model: median and latest tokens per second. */
export function aggregate(samples, since, now) {
  const groups = new Map()
  for (const entry of samples) {
    if (!eligible(entry, since, now)) continue
    const key = `${entry.agent}\u0000${entry.model}`
    let group = groups.get(key)
    if (!group) {
      group = { agent: entry.agent, model: entry.model, rates: [], latest: null, estimated: false }
      groups.set(key, group)
    }
    const rate = (entry.tokens * 1000) / entry.ms
    group.rates.push(rate)
    if (!group.latest || entry.at > group.latest.at) group.latest = { at: entry.at, rate }
    if (entry.estimated) group.estimated = true
  }
  return [...groups.values()].map((group) => ({
    agent: group.agent,
    model: group.model,
    tokPerSec: round1(median(group.rates)),
    latest: round1(group.latest.rate),
    lastAt: group.latest.at,
    samples: group.rates.length,
    estimated: group.estimated
  }))
}

function round1(value) {
  return value === null ? null : Math.round(value * 10) / 10
}

// ---------------------------------------------------------------------------
// Claude Code

/** Claude Code names a project folder after the cwd, every non-alphanumeric as `-`. */
export function claudeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-')
}

/** Lines that are large and carry nothing this parser reads. Matched at the start of
 *  the line only: the same words inside a message must not drop that message. */
function claudeSkip(line) {
  return line.startsWith('{"type":"api-request-blob"') || line.startsWith('{"type":"api-request-shape"')
}

/** Claude Code does not log the window. A request larger than 200k proves the wide
 *  one; below that the standard window is assumed, so the percentage is an estimate. */
function claudeWindow(model, tokens, wide) {
  if (wide || /\[1m\]$/i.test(model) || tokens > CLAUDE_WINDOW) return CLAUDE_WINDOW_1M
  return CLAUDE_WINDOW
}

/**
 * One transcript → its speed samples and the context of its latest main-chain request.
 *
 * An assistant message is logged once per content block under the same `message.id`,
 * so blocks are collapsed: the largest `output_tokens`, ending at the last block. The
 * request started at the `api-request` record the blocks point to (`requestRef`) when
 * the transcript has one, else at the record the first block answers (its parent,
 * skipping attachments). Either way the time to the first token is included, so the
 * figure is an estimate.
 */
export function parseClaude(text) {
  const byUuid = new Map()
  const requests = new Map()
  const messages = new Map()
  /** Model → the largest context any main-chain request of it reached. */
  const peaks = new Map()
  let context = null
  let wide = false

  for (const record of jsonLines(text, claudeSkip)) {
    const at = ms(record.timestamp)
    if (record.type === 'api-request') {
      if (typeof record.id === 'string' && at !== null) requests.set(record.id, at)
      const betas = record.params?.betas
      if (Array.isArray(betas) && betas.some((beta) => /context-1m/.test(String(beta)))) wide = true
      continue
    }
    if (typeof record.uuid === 'string') {
      byUuid.set(record.uuid, { at, parent: record.parentUuid ?? null, type: record.type })
    }
    if (record.type !== 'assistant' || !isRecord(record.message)) continue
    const message = record.message
    const model = typeof message.model === 'string' ? message.model : ''
    if (!model || model === '<synthetic>' || !isRecord(message.usage) || at === null) continue
    const id = typeof message.id === 'string' ? message.id : record.uuid
    if (typeof id !== 'string') continue

    const output = num(message.usage.output_tokens)
    let entry = messages.get(id)
    if (!entry) {
      entry = {
        model,
        output,
        firstAt: at,
        lastAt: at,
        parent: record.parentUuid ?? null,
        requestRef: typeof record.requestRef === 'string' ? record.requestRef : null
      }
      messages.set(id, entry)
    } else {
      entry.output = Math.max(entry.output, output)
      entry.lastAt = Math.max(entry.lastAt, at)
      if (at < entry.firstAt) {
        entry.firstAt = at
        entry.parent = record.parentUuid ?? null
      }
    }

    if (record.isSidechain !== true) {
      const tokens =
        num(message.usage.input_tokens) +
        num(message.usage.cache_read_input_tokens) +
        num(message.usage.cache_creation_input_tokens)
      if (tokens > 0 && (!context || at >= context.at)) context = { tokens, model, at }
      if (tokens > (peaks.get(model) ?? 0)) peaks.set(model, tokens)
    }
  }

  const samples = []
  for (const entry of messages.values()) {
    let startedAt = entry.requestRef ? (requests.get(entry.requestRef) ?? null) : null
    if (startedAt === null) {
      let parent = entry.parent ? byUuid.get(entry.parent) : undefined
      for (let hops = 0; parent && parent.type === 'attachment' && hops < 64; hops += 1) {
        parent = parent.parent ? byUuid.get(parent.parent) : undefined
      }
      // The record this message answers fell outside the tail that was read: no guess.
      startedAt = parent ? parent.at : null
    }
    if (startedAt === null) continue
    samples.push(sample('claude', entry.model, entry.output, entry.lastAt - startedAt, entry.lastAt, true))
  }

  if (context) {
    context = {
      ...context,
      window: claudeWindow(context.model, context.tokens, wide),
      windowEstimated: true
    }
  }
  return { samples, context, peaks }
}

function claudeRoots(env, home) {
  const config = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  const candidates = [path.join(config, 'projects')]
  const profiles = path.join(configHome(env, home), 'orca', 'claude-profiles')
  for (const entry of listDir(profiles)) {
    candidates.push(path.join(profiles, entry.name, 'home', 'projects'))
  }
  return uniqueDirs(candidates)
}

function configHome(env, home) {
  return env.XDG_CONFIG_HOME || path.join(home, '.config')
}

function dataHome(env, home) {
  return env.XDG_DATA_HOME || path.join(home, '.local', 'share')
}

/** Transcripts of one project folder: the sessions themselves and their subagents. */
function claudeFiles(projectDir) {
  const main = []
  const side = []
  for (const entry of listDir(projectDir)) {
    const full = path.join(projectDir, entry.name)
    if (entry.name.endsWith('.jsonl')) {
      const stat = statOrNull(full)
      if (stat && stat.isFile()) main.push({ file: full, mtime: stat.mtimeMs })
    } else if (isDirEntry(projectDir, entry)) {
      const subagents = path.join(full, 'subagents')
      for (const child of listDir(subagents)) {
        if (!child.name.endsWith('.jsonl')) continue
        const stat = statOrNull(path.join(subagents, child.name))
        if (stat && stat.isFile()) side.push({ file: path.join(subagents, child.name), mtime: stat.mtimeMs })
      }
    }
  }
  return { main, side }
}

function collectClaude(run) {
  const roots = claudeRoots(run.env, run.home)
  const wanted = run.agentsByType.get('claude') ?? new Map()
  const wantedDirs = new Map([...wanted.keys()].map((cwd) => [claudeProjectDir(cwd), cwd]))
  const parsed = new Map()
  const sessions = new Map()
  const peaks = new Map()
  const stats = { files: 0, samples: 0 }

  const parse = (file) => {
    if (parsed.has(file)) return parsed.get(file)
    let result = null
    if (run.hasTime()) {
      try {
        result = parseClaude(readTail(file).text)
        for (const [model, tokens] of result.peaks) {
          if (tokens > (peaks.get(model) ?? 0)) peaks.set(model, tokens)
        }
        stats.files += 1
      } catch {
        result = null
      }
    }
    parsed.set(file, result)
    return result
  }

  for (const root of roots) {
    for (const entry of listDir(root)) {
      if (!isDirEntry(root, entry)) continue
      const { main, side } = claudeFiles(path.join(root, entry.name))
      for (const item of [...main, ...side]) {
        if (item.mtime < run.since) continue
        const result = parse(item.file)
        if (result) run.samples.push(...result.samples)
      }
      const cwd = wantedDirs.get(entry.name)
      if (cwd !== undefined) {
        const list = sessions.get(cwd) ?? []
        list.push(...main.filter((item) => item.mtime >= run.now - CONTEXT_LOOKBACK_MS))
        sessions.set(cwd, list)
      }
    }
  }

  assign(run, 'claude', sessions, (item) => {
    const result = parse(item.file)
    return result && result.context ? { ...result.context, sessionAt: item.mtime } : null
  })
  // One session of a model past 200k shows the account runs that model with the wide
  // window, so its other sessions are measured against the same one.
  for (const row of run.rows) {
    if (row.agent !== 'claude' || row.model === null) continue
    if ((peaks.get(row.model) ?? 0) > CLAUDE_WINDOW) row.contextWindow = CLAUDE_WINDOW_1M
  }
  return stats
}

// ---------------------------------------------------------------------------
// Codex

function codexRoots(env, home) {
  const candidates = [path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions')]
  const accounts = path.join(configHome(env, home), 'orca', 'codex-accounts')
  for (const entry of listDir(accounts)) {
    candidates.push(path.join(accounts, entry.name, 'home', 'sessions'))
  }
  return uniqueDirs(candidates)
}

function walkRollouts(dir, out, depth = 0) {
  if (depth > 5) return
  for (const entry of listDir(dir)) {
    const full = path.join(dir, entry.name)
    if (isDirEntry(dir, entry)) {
      walkRollouts(full, out, depth + 1)
    } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      const stat = statOrNull(full)
      if (stat && stat.isFile()) out.push({ file: full, mtime: stat.mtimeMs })
    }
  }
}

/** What the start of a rollout says: where it ran, whether it is a subagent's thread,
 *  and the model of its first turn. */
export function parseCodexHead(text) {
  const head = { cwd: null, subagent: false, model: null }
  for (const record of jsonLines(text)) {
    const payload = isRecord(record.payload) ? record.payload : {}
    if (record.type === 'session_meta') {
      if (typeof payload.cwd === 'string') head.cwd = payload.cwd
      const threadSource = payload.thread_source
      head.subagent =
        (typeof threadSource === 'string' && threadSource !== 'user') ||
        (isRecord(payload.source) && 'subagent' in payload.source)
    } else if (record.type === 'turn_context' && typeof payload.model === 'string') {
      head.model = payload.model
      break
    }
  }
  return head
}

const CODEX_OUTPUT_ITEMS = new Set([
  'reasoning',
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'web_search_call',
  'tool_search_call'
])

/**
 * One rollout (or its tail) → speed samples and the latest context.
 *
 * `task_complete.duration_ms` spans the whole turn, tool runs included, so it is not
 * used. A response is timed on its own instead: it starts when the previous one was
 * accounted for (`token_count`, written once its tool output is in) or when the turn
 * started, and ends at its `token_usage_record`, or at its last output item when the
 * rollout has no such record. `output_tokens` already includes reasoning tokens.
 */
export function parseCodex(text, head = {}) {
  let model = head.model ?? null
  let startedAt = null
  let endedAt = null
  let lastItemAt = null
  let lastTotal = null
  let context = null
  let window = null
  const samples = []

  for (const record of jsonLines(text)) {
    const at = ms(record.timestamp)
    const payload = isRecord(record.payload) ? record.payload : {}
    if (record.type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model
      continue
    }
    if (record.type === 'token_usage_record') {
      if (at !== null) endedAt = at
      continue
    }
    if (record.type === 'response_item') {
      const kind = payload.type
      if (at !== null && (CODEX_OUTPUT_ITEMS.has(kind) || (kind === 'message' && payload.role === 'assistant'))) {
        lastItemAt = at
      }
      continue
    }
    if (record.type !== 'event_msg') continue
    if (payload.type === 'task_started') {
      startedAt = at
      endedAt = null
      lastItemAt = null
      if (num(payload.model_context_window) > 0) window = payload.model_context_window
      continue
    }
    if (payload.type !== 'token_count' || !isRecord(payload.info)) continue

    const info = payload.info
    const last = isRecord(info.last_token_usage) ? info.last_token_usage : null
    const total = isRecord(info.total_token_usage) ? num(info.total_token_usage.total_tokens) : null
    if (num(info.model_context_window) > 0) window = info.model_context_window
    // Codex repeats a `token_count` when only the rate limits moved; that is not a response.
    const repeated = total !== null && total === lastTotal
    lastTotal = total
    if (!last || repeated) continue

    const finishedAt = endedAt ?? lastItemAt
    if (startedAt !== null && finishedAt !== null && at !== null) {
      const tokens =
        num(last.output_tokens) +
        (info.last_usage_includes_reasoning === false ? num(last.reasoning_output_tokens) : 0)
      samples.push(sample('codex', model, tokens, finishedAt - startedAt, finishedAt, true))
    }
    if (num(last.total_tokens) > 0 && at !== null) {
      context = { tokens: num(last.total_tokens), model: model ?? 'unknown', at, window }
    }
    startedAt = at
    endedAt = null
    lastItemAt = null
  }

  if (context) {
    context = { ...context, window: context.window ?? window, windowEstimated: false }
  }
  return { samples, context }
}

function collectCodex(run) {
  const files = []
  const seen = new Set()
  for (const root of codexRoots(run.env, run.home)) {
    const found = []
    walkRollouts(root, found)
    for (const item of found) {
      const real = realOrSelf(item.file)
      if (seen.has(real)) continue
      seen.add(real)
      files.push(item)
    }
  }
  files.sort((left, right) => right.mtime - left.mtime)

  const wanted = run.agentsByType.get('codex') ?? new Map()
  const lookback = wanted.size > 0 ? run.now - CONTEXT_LOOKBACK_MS : run.since
  const sessions = new Map()
  const parsed = new Map()
  const stats = { files: 0, samples: 0 }

  const parse = (item) => {
    if (parsed.has(item.file)) return parsed.get(item.file)
    let result = null
    if (run.hasTime()) {
      try {
        const tail = readTail(item.file)
        // The model is named once per turn, and a turn can be longer than the tail, so
        // a cut rollout takes its first turn's model from the head.
        if (tail.truncated && item.head.model === null) {
          item.head.model = parseCodexHead(readHead(item.file, HEAD_LARGE_BYTES)).model
        }
        result = parseCodex(tail.text, tail.truncated ? item.head : {})
        stats.files += 1
      } catch {
        result = null
      }
    }
    parsed.set(item.file, result)
    return result
  }

  for (const item of files.slice(0, MAX_FILES_PER_SOURCE)) {
    if (item.mtime < Math.min(lookback, run.since)) break
    if (!run.hasTime()) break
    try {
      item.head = parseCodexHead(readHead(item.file, HEAD_SMALL_BYTES))
      if (item.head.cwd === null) item.head = parseCodexHead(readHead(item.file, HEAD_LARGE_BYTES))
    } catch {
      continue
    }
    if (item.mtime >= run.since) {
      const result = parse(item)
      if (result) run.samples.push(...result.samples)
    }
    if (!item.head.subagent && item.head.cwd !== null && wanted.has(item.head.cwd)) {
      const list = sessions.get(item.head.cwd) ?? []
      list.push(item)
      sessions.set(item.head.cwd, list)
    }
  }

  assign(run, 'codex', sessions, (item) => {
    const result = parse(item)
    return result && result.context ? { ...result.context, sessionAt: item.mtime } : null
  })
  return stats
}

// ---------------------------------------------------------------------------
// pi

/** pi names a session folder after the cwd: separators and `:` as `-`, wrapped in `--`. */
export function piSessionDir(cwd) {
  return `--${String(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/** `models.json` → `provider/model` and bare model id → context window. */
export function piWindows(config) {
  const windows = new Map()
  const providers = isRecord(config) && isRecord(config.providers) ? config.providers : {}
  for (const [provider, entry] of Object.entries(providers)) {
    const models = isRecord(entry) && Array.isArray(entry.models) ? entry.models : []
    for (const model of models) {
      if (!isRecord(model) || typeof model.id !== 'string' || !(num(model.contextWindow) > 0)) continue
      windows.set(`${provider}/${model.id}`, model.contextWindow)
      if (!windows.has(model.id)) windows.set(model.id, model.contextWindow)
    }
  }
  return windows
}

/**
 * One pi session → speed samples and the latest context.
 *
 * pi records how long each assistant message took (`durationMs`) and its usage.
 * `usage.reasoning` is a subset of `usage.output` (pi-ai's `Usage` type says so), so
 * only `output` is counted. `usage.totalTokens` is input, output and cache together:
 * what the next request starts from.
 */
export function parsePi(text, windows = new Map()) {
  const samples = []
  let context = null
  let cwd = null
  for (const record of jsonLines(text)) {
    if (record.type === 'session') {
      if (typeof record.cwd === 'string') cwd = record.cwd
      continue
    }
    if (record.type !== 'message' || !isRecord(record.message)) continue
    const message = record.message
    if (message.role !== 'assistant' || !isRecord(message.usage)) continue
    const at = ms(record.timestamp) ?? ms(message.timestamp)
    const model = typeof message.model === 'string' ? message.model : 'unknown'
    if (at === null) continue
    if (num(message.durationMs) > 0) {
      samples.push(sample('pi', model, num(message.usage.output), message.durationMs, at, false))
    }
    const tokens = num(message.usage.totalTokens)
    if (tokens > 0) {
      const window = windows.get(`${message.provider}/${model}`) ?? windows.get(model) ?? null
      context = { tokens, model, at, window, windowEstimated: false }
    }
  }
  return { samples, context, cwd }
}

function collectPi(run) {
  const agentDir = run.env.PI_CODING_AGENT_DIR || path.join(run.home, '.pi', 'agent')
  const root = path.join(agentDir, 'sessions')
  const windows = piWindows(readJsonFile(path.join(agentDir, 'models.json')))
  const wanted = run.agentsByType.get('pi') ?? new Map()
  const wantedDirs = new Map([...wanted.keys()].map((cwd) => [piSessionDir(cwd), cwd]))
  const sessions = new Map()
  const parsed = new Map()
  const stats = { files: 0, samples: 0 }

  const parse = (file) => {
    if (parsed.has(file)) return parsed.get(file)
    let result = null
    if (run.hasTime()) {
      try {
        result = parsePi(readTail(file).text, windows)
        stats.files += 1
      } catch {
        result = null
      }
    }
    parsed.set(file, result)
    return result
  }

  for (const entry of listDir(root)) {
    if (!isDirEntry(root, entry)) continue
    const dir = path.join(root, entry.name)
    const cwd = wantedDirs.get(entry.name)
    for (const child of listDir(dir)) {
      if (!child.name.endsWith('.jsonl')) continue
      const file = path.join(dir, child.name)
      const stat = statOrNull(file)
      if (!stat || !stat.isFile()) continue
      if (stat.mtimeMs >= run.since) {
        const result = parse(file)
        if (result) run.samples.push(...result.samples)
      }
      if (cwd !== undefined && stat.mtimeMs >= run.now - CONTEXT_LOOKBACK_MS) {
        const list = sessions.get(cwd) ?? []
        list.push({ file, mtime: stat.mtimeMs })
        sessions.set(cwd, list)
      }
    }
  }

  assign(run, 'pi', sessions, (item) => {
    const result = parse(item.file)
    return result && result.context ? { ...result.context, sessionAt: item.mtime } : null
  })
  return stats
}

// ---------------------------------------------------------------------------
// OpenCode

/** `opencode.json` → `provider/model` → `limit.context`. */
export function opencodeWindows(config) {
  const windows = new Map()
  const providers = isRecord(config) && isRecord(config.provider) ? config.provider : {}
  for (const [provider, entry] of Object.entries(providers)) {
    const models = isRecord(entry) && isRecord(entry.models) ? entry.models : {}
    for (const [id, model] of Object.entries(models)) {
      const limit = isRecord(model) && isRecord(model.limit) ? num(model.limit.context) : 0
      if (limit > 0) windows.set(`${provider}/${id}`, limit)
    }
  }
  return windows
}

function parseColumn(value) {
  if (typeof value !== 'string') return isRecord(value) ? value : {}
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * One `session_message` row of type `assistant` → `{ sample, context }`.
 *
 * OpenCode keeps reasoning tokens apart from output tokens, so both count. `streamed`
 * is when the stream ended (`completed` follows it by a fixed bookkeeping delay), so
 * the response ran from `created` to `streamed`.
 */
export function opencodeMessage(row, windows = new Map()) {
  const tokens = parseColumn(row.tokens)
  const time = parseColumn(row.time)
  const model = parseColumn(row.model)
  const cache = isRecord(tokens.cache) ? tokens.cache : {}
  const id = typeof model.id === 'string' ? model.id : 'unknown'
  const created = num(time.created)
  const finished = num(time.streamed) || num(time.completed)
  const generated = num(tokens.output) + num(tokens.reasoning)
  const used = num(tokens.input) + num(cache.read) + num(cache.write)
  return {
    sample:
      created > 0 && finished > created
        ? sample('opencode', id, generated, finished - created, finished, false)
        : null,
    context:
      used > 0
        ? {
            tokens: used,
            model: id,
            at: finished || created,
            window: windows.get(`${model.providerID}/${id}`) ?? null,
            windowEstimated: false
          }
        : null
  }
}

const OPENCODE_COLUMNS =
  "json_extract(m.data, '$.tokens') AS tokens, json_extract(m.data, '$.time') AS time, " +
  "json_extract(m.data, '$.model') AS model"

function opencodeConfig(env, home) {
  const dir = path.join(configHome(env, home), 'opencode')
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    try {
      const parsed = parseJsonc(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (parsed) return parsed
    } catch {
      // Try the next name.
    }
  }
  return null
}

async function collectOpencode(run) {
  const file = run.env.OPENCODE_DB || path.join(dataHome(run.env, run.home), 'opencode', 'opencode.db')
  if (!statOrNull(file)) return { files: 0, samples: 0 }
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return { files: 0, samples: 0, error: 'node:sqlite がありません（Node.js 22.13 以降が必要）' }
  }
  const windows = opencodeWindows(opencodeConfig(run.env, run.home))
  const stats = { files: 1, samples: 0 }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const recent = db
      .prepare(
        `SELECT ${OPENCODE_COLUMNS} FROM session_message m ` +
          "WHERE m.type = 'assistant' AND m.time_created >= ? ORDER BY m.time_created LIMIT 20000"
      )
      .all(run.since)
    for (const row of recent) {
      const message = opencodeMessage(row, windows)
      if (message.sample) run.samples.push(message.sample)
    }

    const wanted = run.agentsByType.get('opencode') ?? new Map()
    const sessions = new Map()
    const bySession = db.prepare(
      'SELECT id, time_updated FROM session_v2 WHERE directory = ? AND parent_id IS NULL ' +
        'AND time_updated >= ? ORDER BY time_updated DESC LIMIT ?'
    )
    for (const [cwd, agents] of wanted) {
      const rows = bySession.all(cwd, run.now - CONTEXT_LOOKBACK_MS, agents.length)
      sessions.set(
        cwd,
        rows.map((row) => ({ id: row.id, mtime: Number(row.time_updated) }))
      )
    }
    const latest = db.prepare(
      `SELECT ${OPENCODE_COLUMNS} FROM session_message m ` +
        "WHERE m.session_id = ? AND m.type = 'assistant' ORDER BY m.seq DESC LIMIT 8"
    )
    assign(run, 'opencode', sessions, (item) => {
      // The newest row can be a response still in flight, with no usage yet.
      for (const row of latest.all(item.id)) {
        const message = opencodeMessage(row, windows)
        if (message.context) return { ...message.context, sessionAt: item.mtime }
      }
      return null
    })
  } finally {
    db.close()
  }
  return stats
}

// ---------------------------------------------------------------------------
// DSH

/** Token accounting of an `assistant/message`, as dsh-tui's own projection reads it:
 *  the reasoning field is `think` or `reasoning` depending on the adapter generation. */
export function dshTokens(usage) {
  if (!isRecord(usage)) return null
  const tokens = {
    input: num(usage.input),
    output: num(usage.output),
    think: num(usage.think) || num(usage.reasoning),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite)
  }
  const total = tokens.input + tokens.output + tokens.think + tokens.cacheRead + tokens.cacheWrite
  return total > 0 ? tokens : null
}

/** When the last chunk of a compact stream record list arrived. A record is either one
 *  timed chunk (`time`) or a run of deltas (`time0` plus the gaps in `dt`). */
export function dshStreamEnd(stream) {
  if (!Array.isArray(stream)) return null
  let end = null
  for (const record of stream) {
    if (!isRecord(record)) continue
    let at = null
    if (typeof record.time === 'number') {
      at = record.time
    } else if (typeof record.time0 === 'number') {
      at = record.time0
      if (Array.isArray(record.dt)) for (const gap of record.dt) at += num(gap)
    }
    if (at !== null && (end === null || at > end)) end = at
  }
  return end
}

/**
 * One DSH session log → header, speed samples and the latest context.
 *
 * Written from dsh-tui's type definitions (its trajectory projection), not from a log
 * that held usage. A step's request goes out after its `request/context` event and the
 * committed `assistant/message` carries the usage and the timed stream.
 */
export function parseDsh(text) {
  const header = { cwd: null, subagent: false }
  const samples = []
  let model = null
  let window = null
  let requestAt = null
  let context = null
  for (const record of jsonLines(text)) {
    if (record.type === 'session') {
      if (typeof record.cwd === 'string') header.cwd = record.cwd
      header.subagent =
        record.origin === 'subagent' ||
        num(record.delegationDepth) > 0 ||
        typeof record.parentSession === 'string'
      continue
    }
    const at = ms(record.time)
    const data = isRecord(record.data) ? record.data : {}
    if (record.type === 'step/start' || record.type === 'request/header') {
      requestAt = at
    } else if (record.type === 'request/context') {
      requestAt = at
      if (typeof data.model === 'string') model = data.model
      if (num(data.contextWindow) > 0) window = data.contextWindow
    } else if (record.type === 'assistant/message') {
      const tokens = dshTokens(data.usage)
      if (!tokens) continue
      const endedAt = dshStreamEnd(data.stream) ?? at
      if (requestAt !== null && endedAt !== null) {
        samples.push(sample('dsh', model, tokens.output + tokens.think, endedAt - requestAt, endedAt, false))
      }
      const used = tokens.input + tokens.cacheRead + tokens.cacheWrite
      if (used > 0) {
        context = { tokens: used, model: model ?? 'unknown', at: endedAt ?? at, window, windowEstimated: false }
      }
      requestAt = null
    }
  }
  if (context && context.window === null) context.window = window
  return { header, samples, context, model, window }
}

function collectDsh(run) {
  const root = path.join(run.home, '.dsh', 'sessions')
  const files = []
  for (const cwdDir of listDir(root)) {
    if (!isDirEntry(root, cwdDir)) continue
    const dir = path.join(root, cwdDir.name)
    for (const session of listDir(dir)) {
      if (!session.name.startsWith('session-')) continue
      const file = path.join(dir, session.name, 'session.v4.jsonl.zstd')
      const stat = statOrNull(file)
      if (stat && stat.isFile() && stat.mtimeMs >= run.since) files.push({ file, mtime: stat.mtimeMs, size: stat.size })
    }
  }
  const stats = { files: 0, samples: 0 }
  if (files.length === 0) return stats
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return { ...stats, error: 'zstd を展開できません（Node.js 22.15 以降が必要）' }
  }
  files.sort((left, right) => right.mtime - left.mtime)
  for (const item of files.slice(0, MAX_FILES_PER_SOURCE)) {
    if (!run.hasTime()) break
    if (item.size > DSH_MAX_BYTES) continue
    let result
    try {
      result = parseDsh(zlib.zstdDecompressSync(fs.readFileSync(item.file)).toString('utf8'))
      stats.files += 1
    } catch {
      continue
    }
    run.samples.push(...result.samples)
    // Orca does not list DSH, so its own log says which sessions are alive.
    if (result.header.subagent || result.header.cwd === null) continue
    run.rows.push({
      id: null,
      agent: 'dsh',
      cwd: result.header.cwd,
      state: run.now - item.mtime <= DSH_WORKING_MS ? 'working' : 'idle',
      ...contextFields(result.context),
      // A session that has not answered yet still names its model and window.
      model: result.context?.model ?? result.model,
      contextWindow: result.context?.window ?? result.window,
      sessionAt: item.mtime
    })
  }
  return stats
}

// ---------------------------------------------------------------------------
// Pairing live agents with sessions

function contextFields(context) {
  return {
    model: context?.model ?? null,
    contextTokens: context?.tokens ?? null,
    contextWindow: context?.window ?? null,
    windowEstimated: Boolean(context?.windowEstimated)
  }
}

/**
 * Orca lists an agent with its workspace path but not its session, so agents and
 * sessions of one kind in one directory are paired newest to newest. A session is
 * never given to two agents; an agent left without one keeps empty figures.
 */
function assign(run, type, sessionsByCwd, readContext) {
  const wanted = run.agentsByType.get(type) ?? new Map()
  for (const [cwd, agents] of wanted) {
    const sessions = [...(sessionsByCwd.get(cwd) ?? [])].sort((left, right) => right.mtime - left.mtime)
    const ordered = [...agents].sort((left, right) => num(right.updatedAt) - num(left.updatedAt))
    ordered.forEach((agent, index) => {
      const session = sessions[index]
      let context = null
      if (session) {
        try {
          context = readContext(session)
        } catch {
          context = null
        }
      }
      run.rows.push({
        id: agent.id,
        agent: type,
        cwd,
        state: agent.state ?? null,
        ...contextFields(context),
        sessionAt: context?.sessionAt ?? null
      })
    })
  }
}

const AGENT_TYPES = ['claude', 'codex', 'pi', 'opencode']

function groupAgents(agents) {
  const byType = new Map()
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!isRecord(agent) || !AGENT_TYPES.includes(agent.type) || typeof agent.cwd !== 'string') continue
    const byCwd = byType.get(agent.type) ?? new Map()
    const list = byCwd.get(agent.cwd) ?? []
    list.push({
      id: agent.id ?? null,
      state: typeof agent.state === 'string' ? agent.state : null,
      updatedAt: num(agent.updatedAt)
    })
    byCwd.set(agent.cwd, list)
    byType.set(agent.type, byCwd)
  }
  return byType
}

// ---------------------------------------------------------------------------
// Entry

/**
 * @param {{ period?: string, agents?: object[], budgetMs?: number }} input
 * @param {{ env?: object, home?: string, now?: number }} [options] Test seams.
 */
export async function collect(input = {}, options = {}) {
  const started = Date.now()
  const now = options.now ?? started
  const period = Object.hasOwn(PERIODS, input.period) ? input.period : '1h'
  const budget = num(input.budgetMs) > 0 ? input.budgetMs : DEFAULT_BUDGET_MS
  const run = {
    env: options.env ?? process.env,
    home: options.home ?? os.homedir(),
    now,
    since: now - PERIODS[period],
    agentsByType: groupAgents(input.agents),
    samples: [],
    rows: [],
    truncated: false,
    hasTime() {
      if (Date.now() - started < budget) return true
      this.truncated = true
      return false
    }
  }

  const sources = {}
  const collectors = [
    ['claude', collectClaude],
    ['codex', collectCodex],
    ['pi', collectPi],
    ['opencode', collectOpencode],
    ['dsh', collectDsh]
  ]
  for (const [name, collector] of collectors) {
    const before = run.samples.length
    try {
      sources[name] = await collector(run)
    } catch (error) {
      sources[name] = { files: 0, samples: 0, error: String(error?.message ?? error).slice(0, 200) }
    }
    sources[name].samples = run.samples.slice(before).filter((entry) => eligible(entry, run.since, now)).length
  }

  // A kind that failed before pairing still owes every listed agent a row.
  const listed = new Set(run.rows.map((row) => row.id).filter((id) => id !== null))
  for (const [type, byCwd] of run.agentsByType) {
    for (const [cwd, agents] of byCwd) {
      for (const agent of agents) {
        if (listed.has(agent.id)) continue
        run.rows.push({ id: agent.id, agent: type, cwd, state: agent.state, ...contextFields(null), sessionAt: null })
      }
    }
  }

  return {
    v: 1,
    ok: true,
    at: now,
    node: process.version,
    period,
    tookMs: Date.now() - started,
    truncated: run.truncated,
    models: aggregate(run.samples, run.since, now),
    agents: run.rows,
    sources
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  return text
}

async function main() {
  let result
  try {
    // Piped over SSH the worker puts the input in front of this script; run as a file
    // it comes on stdin.
    let input = globalThis.__AGENT_METER_INPUT__
    if (input === undefined) {
      const text = (await readStdin()).trim()
      input = text ? JSON.parse(text) : {}
    }
    result = await collect(isRecord(input) ? input : {})
  } catch (error) {
    result = { v: 1, ok: false, node: process.version, error: String(error?.message ?? error).slice(0, 300) }
  }
  // No process.exit(): it can cut a pipe short. The script ends when the write drains.
  process.stdout.write(`${SENTINEL}${JSON.stringify(result)}\n`)
}

function isMain() {
  if (globalThis.__AGENT_METER_INPUT__ !== undefined) return true
  try {
    return Boolean(process.argv[1]) && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) await main()
