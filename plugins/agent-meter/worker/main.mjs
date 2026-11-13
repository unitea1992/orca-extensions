// Agent Meter worker.
//
// The agents run on an Orca server; this worker runs on the desktop that shows the
// panel. Their session logs (token counts, timings) are files on the server that no
// Orca host call reaches, so every refresh the worker pipes ../reader/reader.mjs to a
// Node on the server over SSH and reads one JSON line back. Which agents are alive
// comes from `orca worktree ps --environment`, the same way gate-inbox reads a paired
// server.
//
// The plugin contributes a status bar item, so Orca keeps this worker running while
// the plugin is enabled. The worker is the only poller: it updates the status bar and
// posts to open panels when something changed.

import { exec, execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'

const CLI = process.platform === 'win32' ? 'orca.cmd' : 'orca'
/** Every CLI token we pass is checked against this, so no value can reach a shell. */
export const SAFE_ARG = /^[A-Za-z0-9._:@+-]+$/
const CLI_TIMEOUT_MS = 20_000
const SSH_TIMEOUT_MS = 25_000
const ENVIRONMENTS_TTL_MS = 60_000
const TERMINALS_TTL_MS = 60_000
const STATUS_ITEM = 'meter'
/** Must match SENTINEL in reader/reader.mjs. */
export const SENTINEL = 'AGENT_METER_RESULT '
const NODE_MISSING = 'AGENT_METER_NODE_NOT_FOUND'

export const PERIOD_LABELS = { '15m': '直近15分', '1h': '直近1時間', '24h': '直近24時間' }
const AGENT_LABELS = { claude: 'Claude', codex: 'Codex', pi: 'pi', opencode: 'OpenCode', dsh: 'DSH' }
const AGENT_ORDER = ['claude', 'codex', 'pi', 'opencode', 'dsh']
export const WARN_PERCENT = 70
export const DANGER_PERCENT = 90

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// ---------------------------------------------------------------------------
// SSH

/** `user@host`, a host, or a Host alias from ~/.ssh/config. A leading `-` would be read
 *  by ssh as an option. */
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@:%[\]-]*$/
/** No spaces or quotes: the value is placed inside the remote `sh -c '…'`. */
const REMOTE_PATH = /^[A-Za-z0-9_.~/][A-Za-z0-9_.~/@+-]*$/

export function checkTarget(target) {
  if (!SSH_TARGET.test(target)) {
    throw fail(
      'invalid_params',
      '設定「SSH 接続先」は user@host か ~/.ssh/config の Host 名で入れてください（空白や先頭の - は使えません）'
    )
  }
  return target
}

/**
 * The remote command. ssh hands it to the account's login shell, which may be fish or
 * zsh, so it is one `sh -c '…'` whose body has no quote and no backslash: nothing for
 * that shell, or for Windows argument quoting on the way out, to reinterpret.
 *
 * A non-interactive SSH session rarely has `node` on PATH (mise, nvm and volta set it
 * up in rc files), so the body looks in the usual places. Paths are relative to the
 * home directory the session starts in, which keeps `$HOME` out of unquoted words.
 */
export function buildBootstrap(remoteNode = '') {
  let preset = ''
  const configured = String(remoteNode).trim()
  if (configured) {
    if (!REMOTE_PATH.test(configured)) {
      throw fail(
        'invalid_params',
        '設定「リモートの node」は空白や引用符を含まないパスで入れてください（例: /usr/local/bin/node）'
      )
    }
    preset = configured.startsWith('~/') ? configured.slice(2) : configured
  }
  const body = [
    'cd || exit 97',
    `n=${preset}`,
    '[ ${n:-0} = 0 ] && n=$(command -v node 2>/dev/null)',
    'for c in .local/share/mise/shims/node .volta/bin/node .asdf/shims/node' +
      ' .local/share/fnm/aliases/default/bin/node' +
      ' $(ls -d .nvm/versions/node/*/bin/node 2>/dev/null </dev/null | sort -V | tail -n 1)' +
      ' /usr/local/bin/node /opt/homebrew/bin/node' +
      '; do [ ${n:-0} = 0 ] || break; [ -x $c ] && n=$c; done',
    `[ \${n:-0} = 0 ] && { echo ${NODE_MISSING} >&2; exit 127; }`,
    `[ -x $n ] || command -v $n >/dev/null 2>&1 || { echo ${NODE_MISSING} >&2; exit 127; }`,
    'exec $n --input-type=module - --json'
  ].join('; ')
  return `sh -c '${body}'`
}

function expandHome(file) {
  if (file === '~') return homedir()
  if (file.startsWith('~/') || file.startsWith('~\\')) return join(homedir(), file.slice(2))
  return file
}

export function buildSshArgs({ sshTarget, identityFile = '', remoteNode = '' }) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
  const identity = String(identityFile).trim()
  if (identity) args.push('-i', expandHome(identity))
  args.push('--', checkTarget(String(sshTarget).trim()), buildBootstrap(remoteNode))
  return args
}

/** Orca starts a plugin worker with a reduced environment. ssh finds ~/.ssh/config and
 *  the keys through the home directory, and the orca CLI finds its saved environments
 *  the same way, so restore what is missing. */
export function childEnv(base = process.env, platform = process.platform) {
  const env = { ...base }
  if (!env.HOME) env.HOME = homedir()
  if (platform !== 'win32' && !env.PATH) env.PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
  if (platform === 'win32') {
    if (!env.USERPROFILE) env.USERPROFILE = homedir()
    if (!env.APPDATA) env.APPDATA = join(homedir(), 'AppData', 'Roaming')
    if (!env.LOCALAPPDATA) env.LOCALAPPDATA = join(homedir(), 'AppData', 'Local')
    // Winsock does not start without it.
    if (!env.SystemRoot && !env.SYSTEMROOT) env.SystemRoot = 'C:\\Windows'
  }
  return env
}

/** On Windows spawn does not search PATH the way a shell does for a bare name when the
 *  environment was reduced, so name the OpenSSH client outright. */
export function resolveSsh(env = process.env, platform = process.platform, exists = existsSync) {
  if (platform !== 'win32') return 'ssh'
  const dirs = String(env.PATH ?? env.Path ?? '')
    .split(win32.delimiter)
    .filter(Boolean)
  for (const dir of dirs) {
    const candidate = win32.join(dir, 'ssh.exe')
    if (exists(candidate)) return candidate
  }
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const bundled = win32.join(root, 'System32', 'OpenSSH', 'ssh.exe')
  return exists(bundled) ? bundled : 'ssh.exe'
}

/** → the reader's result, picked by its sentinel: a remote rc file may print as well. */
export function parseReaderOutput(stdout) {
  const lines = String(stdout).split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const at = lines[index].indexOf(SENTINEL)
    if (at === -1) continue
    try {
      return JSON.parse(lines[index].slice(at + SENTINEL.length))
    } catch {
      return null
    }
  }
  return null
}

function lastLine(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/ExperimentalWarning|--trace-warnings/.test(line))
  return lines.length > 0 ? lines[lines.length - 1].slice(0, 200) : ''
}

/** What went wrong, in words the person can act on. */
export function readerError({ spawnError, timedOut, code, stdout, stderr }) {
  if (spawnError) {
    return spawnError.code === 'ENOENT'
      ? fail('ssh_missing', 'ssh が見つかりません。OpenSSH クライアントを入れてください')
      : fail('ssh_failed', `ssh を起動できません: ${spawnError.message}`)
  }
  if (timedOut) return fail('timeout', `サーバーの応答が ${SSH_TIMEOUT_MS / 1000} 秒以内にありません`)
  if (String(stderr).includes(NODE_MISSING)) {
    return fail(
      'node_missing',
      'サーバーに Node.js が見つかりません。設定「リモートの node」に node の絶対パスを入れてください'
    )
  }
  const result = parseReaderOutput(stdout)
  if (result && result.ok === false) {
    return fail('reader_failed', `サーバー側の読み取りに失敗しました: ${result.error ?? '不明なエラー'}`)
  }
  if (result) return null
  const detail = lastLine(stderr)
  if (code === 255) return fail('ssh_failed', `SSH で接続できません${detail ? `: ${detail}` : ''}`)
  return fail(
    'reader_failed',
    `サーバー側の読み取りに失敗しました（終了コード ${code ?? '-'}）${detail ? `: ${detail}` : ''}`
  )
}

/** Child processes still running, so `deactivate` can stop them. */
const children = new Set()

function killTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    // ssh may have started a ProxyCommand; /T takes the whole tree.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.on('error', () => child.kill())
    return
  }
  try {
    // Started detached, so the child leads its own process group.
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

let readerSource = null

function readerScript() {
  readerSource ??= readFileSync(new URL('../reader/reader.mjs', import.meta.url), 'utf8')
  return readerSource
}

/** The reader takes its input as a line in front of its own source, so nothing but the
 *  fixed bootstrap ever travels on the command line. */
export function readerPayload(input, script) {
  return `globalThis.__AGENT_METER_INPUT__ = ${JSON.stringify(input)};\n${script}`
}

function runReader(settings, input) {
  const args = buildSshArgs(settings)
  const payload = readerPayload(input, readerScript())
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn(resolveSsh(childEnv()), args, {
      env: childEnv(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    children.add(child)
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, SSH_TIMEOUT_MS)
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      children.delete(child)
      const error = readerError({ ...outcome, timedOut, stdout, stderr })
      if (error) reject(error)
      else resolve(parseReaderOutput(stdout))
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })
    child.on('error', (spawnError) => finish({ spawnError }))
    child.on('close', (code) => finish({ code }))
    // ssh that fails to connect closes stdin before the script is written.
    child.stdin.on('error', () => {})
    child.stdin.end(payload)
  })
}

// ---------------------------------------------------------------------------
// orca CLI

function checked(args) {
  for (const arg of args) {
    if (!SAFE_ARG.test(arg)) {
      throw fail('invalid_params', `refusing to pass ${JSON.stringify(arg)} to the orca CLI`)
    }
  }
  return args
}

function runCli(args, timeout = CLI_TIMEOUT_MS) {
  checked(args)
  const options = { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: childEnv() }
  return new Promise((resolve, reject) => {
    let child = null
    const done = (error, stdout, stderr) => {
      children.delete(child)
      let payload = null
      try {
        payload = JSON.parse(stdout)
      } catch {
        // Not JSON: fall through to the process error.
      }
      // A refused call still prints its JSON envelope on stdout; prefer that message.
      if (payload && payload.ok === false) {
        reject(fail(payload.error?.code ?? 'action_failed', payload.error?.message ?? 'the orca CLI refused the call'))
        return
      }
      if (error || !payload) {
        const detail = lastLine(stderr) || lastLine(stdout) || error?.message || 'unexpected output'
        reject(fail('action_failed', `orca ${args.slice(0, 2).join(' ')}: ${detail}`))
        return
      }
      resolve(payload.result ?? payload)
    }
    if (process.platform === 'win32') {
      // An npm .cmd shim cannot be spawned without a shell. `exec` takes one command
      // string; every token above is validated, so the shell only ever sees plain words.
      child = exec(`${CLI} ${args.join(' ')}`, options, done)
    } else {
      child = execFile(CLI, args, options, done)
    }
    children.add(child)
  })
}

let environmentsCache = { at: 0, list: null }

async function listEnvironments() {
  if (environmentsCache.list && Date.now() - environmentsCache.at < ENVIRONMENTS_TTL_MS) {
    return environmentsCache.list
  }
  const listed = await runCli(['environment', 'list', '--json'])
  const list = (listed.environments ?? []).map((entry) => ({
    id: String(entry.id ?? ''),
    name: String(entry.name ?? '')
  }))
  environmentsCache = { at: Date.now(), list }
  return list
}

/**
 * → `{ arg, label }`: what goes after `--environment`, and what the panel shows.
 * A pairing name may hold spaces or Japanese, which SAFE_ARG refuses; its id selects
 * the same environment, so that is passed instead.
 */
export function pickEnvironment(configured, environments) {
  const wanted = String(configured ?? '').trim()
  if (wanted && SAFE_ARG.test(wanted)) return { arg: wanted, label: wanted }
  const usable = (entry) => {
    const arg = SAFE_ARG.test(entry.name) ? entry.name : entry.id
    if (!SAFE_ARG.test(arg)) {
      throw fail('invalid_params', `環境 ${JSON.stringify(entry.name)} の id を CLI に渡せません`)
    }
    return { arg, label: entry.name || entry.id }
  }
  if (!wanted) {
    return environments.length > 0 ? usable(environments[0]) : { arg: 'local', label: 'local' }
  }
  const matches = environments.filter((entry) => entry.id === wanted || entry.name === wanted)
  if (matches.length !== 1) {
    throw fail(
      'invalid_params',
      matches.length === 0
        ? `設定「Orca サーバー」の ${JSON.stringify(wanted)} が保存済みの環境にありません（orca environment list で確認）`
        : `${JSON.stringify(wanted)} という名前の環境が複数あります。設定には id を入れてください`
    )
  }
  if (!SAFE_ARG.test(matches[0].id)) {
    throw fail('invalid_params', `環境 ${JSON.stringify(wanted)} の id を CLI に渡せません`)
  }
  return { arg: matches[0].id, label: matches[0].name || matches[0].id }
}

function baseName(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : String(path)
}

const LISTED_AGENTS = new Set(['claude', 'codex', 'pi', 'opencode'])

/** `orca worktree ps --json` → the live agents the reader pairs with session logs. */
export function flattenAgents(listed) {
  const agents = []
  for (const worktree of listed?.worktrees ?? []) {
    if (typeof worktree?.path !== 'string') continue
    for (const agent of worktree.agents ?? []) {
      if (!LISTED_AGENTS.has(agent?.agentType) || typeof agent.paneKey !== 'string') continue
      agents.push({
        id: agent.paneKey,
        type: agent.agentType,
        state: String(agent.state ?? ''),
        cwd: worktree.path,
        name: String(worktree.displayName || baseName(worktree.path)),
        updatedAt: Number(agent.updatedAt) || 0
      })
    }
  }
  return agents
}

/** `orca terminal list --json` → pane key (`tabId:leafId`) → terminal handle. */
export function terminalHandles(listed) {
  const handles = new Map()
  for (const terminal of listed?.terminals ?? []) {
    if (typeof terminal?.handle !== 'string' || !SAFE_ARG.test(terminal.handle)) continue
    if (typeof terminal.tabId !== 'string' || typeof terminal.leafId !== 'string') continue
    handles.set(`${terminal.tabId}:${terminal.leafId}`, terminal.handle)
  }
  return handles
}

// ---------------------------------------------------------------------------
// Snapshot: what the panel and the status bar show

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function order(agent) {
  const index = AGENT_ORDER.indexOf(agent)
  return index === -1 ? AGENT_ORDER.length : index
}

/** Reader result + Orca's agent list → groups per model with their live agents. */
export function buildGroups(reader, agents = [], handles = new Map()) {
  const live = new Map(agents.map((agent) => [agent.id, agent]))
  const groups = new Map()
  const groupOf = (agent, model) => {
    const key = `${agent}\u0000${model ?? ''}`
    let group = groups.get(key)
    if (!group) {
      group = { agent, model: model ?? null, tokPerSec: null, latest: null, samples: 0, estimated: false, rows: [] }
      groups.set(key, group)
    }
    return group
  }
  for (const model of reader.models ?? []) {
    const group = groupOf(model.agent, model.model)
    group.tokPerSec = model.tokPerSec
    group.latest = model.latest
    group.samples = model.samples
    group.estimated = Boolean(model.estimated)
  }
  for (const row of reader.agents ?? []) {
    const known = row.id === null ? undefined : live.get(row.id)
    const tokens = typeof row.contextTokens === 'number' ? row.contextTokens : null
    const window = typeof row.contextWindow === 'number' && row.contextWindow > 0 ? row.contextWindow : null
    const state = known?.state ?? row.state ?? ''
    groupOf(row.agent, row.model).rows.push({
      id: row.id,
      name: known?.name ?? baseName(row.cwd ?? ''),
      state,
      working: state === 'working',
      tokens,
      window,
      percent: tokens !== null && window !== null ? (tokens / window) * 100 : null,
      windowEstimated: Boolean(row.windowEstimated),
      focusable: row.id !== null && handles.has(row.id)
    })
  }
  const list = [...groups.values()]
  for (const group of list) {
    group.rows.sort(
      (left, right) =>
        Number(right.working) - Number(left.working) ||
        (right.percent ?? -1) - (left.percent ?? -1) ||
        left.name.localeCompare(right.name)
    )
  }
  return list.sort(
    (left, right) =>
      order(left.agent) - order(right.agent) ||
      // A kind's agents without a session come after its models.
      Number(left.model === null) - Number(right.model === null) ||
      String(left.model).localeCompare(String(right.model))
  )
}

/** The two figures of the status bar: the median over the models that produced output
 *  in the period, and the fullest context among live agents. */
export function summarize(groups) {
  const speeds = groups.map((group) => group.tokPerSec).filter((value) => typeof value === 'number')
  let fullest = null
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.percent !== null && (fullest === null || row.percent > fullest.percent)) {
        fullest = { percent: row.percent, name: row.name }
      }
    }
  }
  return { tokPerSec: median(speeds), fullest }
}

/** Status bar text and tooltips are one line with a length limit. */
function oneLine(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function shortModel(model) {
  return String(model).replace(/^claude-/, '')
}

export function statusBarItem(snapshot) {
  if (!snapshot.configured) {
    return { text: '⚡ 未設定', tone: 'neutral', tooltip: 'Agent Meter: 設定で SSH 接続先を入れてください' }
  }
  if (snapshot.error) {
    return {
      text: '⚡ 取得失敗',
      tone: 'warning',
      tooltip: oneLine(`Agent Meter: ${snapshot.error.message}`, 256)
    }
  }
  const { tokPerSec, fullest } = summarize(snapshot.groups)
  const parts = [tokPerSec === null ? '⚡ —' : `⚡ ${Math.round(tokPerSec)} tok/s`]
  if (fullest) parts.push(`◔ ${Math.round(fullest.percent)}%`)
  const lines = snapshot.groups
    .filter((group) => group.tokPerSec !== null)
    .map(
      (group) =>
        `${AGENT_LABELS[group.agent] ?? group.agent} ${shortModel(group.model)} ` +
        `${group.estimated ? '≈' : ''}${Math.round(group.tokPerSec)} tok/s`
    )
  if (fullest) lines.push(`最大 ${Math.round(fullest.percent)}% ${fullest.name}`)
  const percent = fullest?.percent ?? 0
  return {
    text: parts.join(' · '),
    tone: percent >= DANGER_PERCENT ? 'danger' : percent >= WARN_PERCENT ? 'warning' : 'neutral',
    tooltip: oneLine(
      `Agent Meter（${PERIOD_LABELS[snapshot.period] ?? snapshot.period}）: ${lines.join(' / ') || 'データなし'}`,
      256
    )
  }
}

/** What the panel compares to decide whether anything changed: everything but the clock. */
export function contentKey(snapshot) {
  return JSON.stringify({ ...snapshot, fetchedAt: 0 })
}

// ---------------------------------------------------------------------------
// Polling

export const DEFAULTS = {
  displayMode: 'statusbar',
  sshTarget: '',
  identityFile: '',
  remoteNode: '',
  environment: '',
  period: '1h',
  refreshSeconds: 15
}

async function readSettings(orca) {
  const settings = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    try {
      const value = await orca.settings.get(key)
      if (value !== undefined && value !== null) settings[key] = value
    } catch {
      // Keep the default.
    }
  }
  settings.sshTarget = String(settings.sshTarget).trim()
  settings.environment = String(settings.environment).trim()
  if (!Object.hasOwn(PERIOD_LABELS, settings.period)) settings.period = DEFAULTS.period
  settings.refreshSeconds = Math.min(600, Math.max(5, Number(settings.refreshSeconds) || DEFAULTS.refreshSeconds))
  return settings
}

/** The worker `activate` started; work that outlives `deactivate` must not publish. */
let active = null
let timer = null
let pollMs = DEFAULTS.refreshSeconds * 1000
/** The one refresh in flight. */
let building = null
/** A setting changed while a refresh was in flight: its result is already stale. */
let dirty = false
/** The snapshot last published. */
let last = null
let lastKey = ''
let lastStatusKey = ''
let lastLogLine = ''
/** When a panel last asked; in panel-only mode the worker polls only while one is open. */
let panelSeenAt = 0
let environment = { arg: 'local', label: 'local' }
let terminals = { at: 0, environment: '', handles: new Map() }

function hostHas(orca, method, sinceMinor) {
  if (typeof orca.host?.has === 'function') return orca.host.has(method)
  return orca.api.major > 1 || orca.api.minor >= sinceMinor
}

function updateStatusBar(orca, patch) {
  if (!hostHas(orca, 'statusBar.update', 2)) return
  const key = JSON.stringify(patch)
  if (key === lastStatusKey) return
  lastStatusKey = key
  orca.host.call('statusBar.update', { id: STATUS_ITEM, ...patch }).catch((error) => {
    lastStatusKey = ''
    orca.log(`statusBar.update ERR ${error.code ?? '-'} ${error.message}`)
  })
}

function logOnce(orca, line) {
  // The worker polls all day; only say what changed.
  if (line === lastLogLine) return
  lastLogLine = line
  orca.log(line)
}

function publish(orca, snapshot, settings) {
  if (active !== orca) return
  last = snapshot
  // Every field goes out each time: an omitted one would keep its old value.
  updateStatusBar(orca, { ...statusBarItem(snapshot), visible: settings.displayMode !== 'panel' })
  const key = contentKey(snapshot)
  try {
    if (key !== lastKey) {
      lastKey = key
      orca.panels.post('snapshot', snapshot)
    } else {
      // Nothing changed; the panel only needs to know the read happened.
      orca.panels.post('tick', { fetchedAt: snapshot.fetchedAt })
    }
  } catch (error) {
    orca.log(`post ERR ${error.message}`)
  }
}

async function readHandles(target) {
  if (terminals.environment === target && Date.now() - terminals.at < TERMINALS_TTL_MS) {
    return terminals.handles
  }
  const listed = await runCli(['terminal', 'list', '--json', '--environment', target, '--limit', '500'])
  terminals = { at: Date.now(), environment: target, handles: terminalHandles(listed) }
  return terminals.handles
}

async function build(orca, settings) {
  const base = {
    configured: Boolean(settings.sshTarget),
    label: settings.environment || settings.sshTarget,
    period: settings.period,
    refreshSeconds: settings.refreshSeconds,
    fetchedAt: Date.now(),
    error: null,
    notice: null,
    groups: []
  }
  if (!base.configured) return base
  try {
    // Checked before anything is spawned, so a bad value reads as a settings problem.
    buildSshArgs(settings)
    let agents = []
    let handles = new Map()
    try {
      // A name the CLI can take as it is needs no lookup.
      const direct = settings.environment !== '' && SAFE_ARG.test(settings.environment)
      environment = pickEnvironment(settings.environment, direct ? [] : await listEnvironments())
      const listed = await runCli(['worktree', 'ps', '--json', '--environment', environment.arg, '--limit', '200'])
      agents = flattenAgents(listed)
      handles = await readHandles(environment.arg).catch(() => new Map())
    } catch (error) {
      // The speeds do not depend on Orca's list, so keep going without it.
      base.notice = `エージェント一覧を取得できません: ${error.message}`
    }
    const reader = await runReader(settings, {
      period: settings.period,
      agents: agents.map(({ id, type, cwd, state, updatedAt }) => ({ id, type, cwd, state, updatedAt }))
    })
    const sourceErrors = Object.entries(reader.sources ?? {})
      .filter(([, source]) => source?.error)
      .map(([name, source]) => `${AGENT_LABELS[name] ?? name}: ${source.error}`)
    if (sourceErrors.length > 0 && !base.notice) base.notice = sourceErrors.join(' / ')
    const groups = buildGroups(reader, agents, handles)
    logOnce(
      orca,
      `state models=${(reader.models ?? []).length} agents=${(reader.agents ?? []).length} node=${reader.node} truncated=${reader.truncated === true}`
    )
    return { ...base, groups }
  } catch (error) {
    logOnce(orca, `state ERR ${error.code ?? '-'} ${error.message}`)
    // Keep the last good figures on screen; the banner says they are old.
    return {
      ...base,
      fetchedAt: last?.fetchedAt ?? base.fetchedAt,
      groups: last?.configured ? last.groups : [],
      error: { code: error.code ?? 'action_failed', message: String(error.message ?? error) }
    }
  }
}

/** Every reader (the timer, a panel, a settings change) goes through here, so there is
 *  never more than one SSH session open. */
function refresh(orca) {
  building ??= (async () => {
    try {
      do {
        dirty = false
        const settings = await readSettings(orca)
        pollMs = settings.refreshSeconds * 1000
        const snapshot = await build(orca, settings)
        if (!dirty) publish(orca, snapshot, settings)
      } while (dirty && active === orca)
    } finally {
      building = null
    }
    return last
  })()
  return building
}

function schedule(orca) {
  clearTimeout(timer)
  if (active !== orca) return
  timer = setTimeout(() => void tick(orca), pollMs)
}

async function tick(orca) {
  try {
    const settings = await readSettings(orca)
    pollMs = settings.refreshSeconds * 1000
    const panelOpen = Date.now() - panelSeenAt < Math.max(3 * pollMs, 45_000)
    if (settings.displayMode !== 'panel' || panelOpen) {
      await refresh(orca)
    } else {
      // Panel-only mode with no panel open: nothing is on screen, so nothing is read.
      updateStatusBar(orca, { visible: false })
    }
  } catch (error) {
    orca.log(`tick ERR ${error.message}`)
  }
  if (active === orca) schedule(orca)
}

async function focusAgent(id) {
  const handle = terminals.handles.get(String(id))
  if (!handle) throw fail('not_found', 'このエージェントの端末が見つかりません')
  await runCli(['terminal', 'focus', '--terminal', handle, '--environment', environment.arg, '--json'])
  return { ok: true }
}

export default function activate(orca) {
  orca.log(
    `activate host-api ${orca.api.major}.${orca.api.minor} granted=${orca.grantedCapabilities.join(',')}`
  )
  active = orca
  building = null
  dirty = false
  last = null
  lastKey = ''
  lastStatusKey = ''
  lastLogLine = ''
  panelSeenAt = 0

  // A panel asks when it opens and while it stays visible. It gets what is already
  // known at once; a stale answer is followed by a post when the read finishes.
  orca.panels.handle('snapshot.get', async () => {
    panelSeenAt = Date.now()
    if (!last) return refresh(orca)
    if (Date.now() - last.fetchedAt > 2 * pollMs) void refresh(orca)
    return last
  })
  orca.panels.handle('agent.focus', (input) => focusAgent(input?.id))

  if (typeof orca.settings.onDidChange === 'function') {
    orca.settings.onDidChange(() => {
      if (active !== orca) return
      dirty = true
      clearTimeout(timer)
      void tick(orca)
    })
  }

  void tick(orca)
}

export function deactivate() {
  active = null
  clearTimeout(timer)
  timer = null
  for (const child of children) killTree(child)
  children.clear()
}
