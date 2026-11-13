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
// posts to open panels when something changed. It reads the server only while there
// is something on screen to keep current: always with the status bar item shown, and
// with `displayMode: panel` only while a panel is open. Otherwise no timer runs.

import { exec, execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, win32 } from 'node:path'

const CLI = process.platform === 'win32' ? 'orca.cmd' : 'orca'
/** Every CLI token we pass is checked against this, so no value can reach a shell. */
export const SAFE_ARG = /^[A-Za-z0-9._:@+-]+$/
const CLI_TIMEOUT_MS = 20_000
const SSH_TIMEOUT_MS = 25_000
const ENVIRONMENTS_TTL_MS = 60_000
const TERMINALS_TTL_MS = 60_000
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
export function buildBootstrap(remoteNode = '', nodeArgs = '--input-type=module - --json') {
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
    `exec $n ${nodeArgs}`
  ].join('; ')
  return `sh -c '${body}'`
}

function expandHome(file) {
  if (file === '~') return homedir()
  if (file.startsWith('~/') || file.startsWith('~\\')) return join(homedir(), file.slice(2))
  return file
}

/**
 * The arguments for one ssh run of `command` on the configured target.
 *
 * Nothing here holds a double quote or a newline, and only an identity path can hold a
 * backslash, so the one quoting pass Node does on Windows (wrap a word with spaces in
 * double quotes) hands ssh.exe exactly these words. The target cannot start with `-`
 * (checkTarget), so no `--` is needed in front of it.
 */
export function buildSshArgs({ sshTarget, identityFile = '', remoteNode = '' }, command, extra = []) {
  const args = [...extra, '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
  const identity = String(identityFile).trim()
  if (identity) args.push('-i', expandHome(identity))
  args.push(checkTarget(String(sshTarget).trim()), command ?? buildBootstrap(remoteNode))
  return args
}

function envName(env, name) {
  const wanted = name.toUpperCase()
  return Object.keys(env).find((key) => key.toUpperCase() === wanted)
}

function userName() {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

/**
 * The environment for ssh and the orca CLI.
 *
 * Orca starts a plugin worker with a reduced environment, and what a child process
 * inherits from it is not what the same command sees in a terminal. On Windows that
 * matters to ssh.exe: OpenSSH for Windows reads `ProgramData` first thing at startup
 * (`init_prog_paths`) and, when it is missing, ends with exit code 255 before its
 * stderr is set up, so without a word. Winsock in turn needs `SystemRoot`. So the
 * variables a normal Windows session always has are restored here when absent; ones
 * that are present are never changed. Names are matched without regard to case, as
 * Windows does.
 */
export function childEnv(base = process.env, platform = process.platform, home = homedir()) {
  const env = { ...base }
  if (platform !== 'win32') {
    if (!env.HOME) env.HOME = home
    if (!env.PATH) env.PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
    return env
  }
  const get = (name) => {
    const key = envName(env, name)
    return key === undefined ? '' : String(env[key] ?? '')
  }
  const fill = (name, value) => {
    if (!get(name) && value) env[envName(env, name) ?? name] = value
  }
  fill('SystemRoot', 'C:\\Windows')
  const root = get('SystemRoot')
  const drive = /^[A-Za-z]:/.test(root) ? root.slice(0, 2) : 'C:'
  const system32 = win32.join(root, 'System32')
  fill('SystemDrive', drive)
  fill('windir', root)
  fill('ComSpec', win32.join(system32, 'cmd.exe'))
  fill('PATHEXT', '.COM;.EXE;.BAT;.CMD')
  fill('ProgramData', `${drive}\\ProgramData`)
  fill('ALLUSERSPROFILE', get('ProgramData'))
  fill('USERPROFILE', home)
  fill('HOME', home)
  if (/^[A-Za-z]:/.test(home)) {
    fill('HOMEDRIVE', home.slice(0, 2))
    fill('HOMEPATH', home.slice(2) || '\\')
  }
  fill('APPDATA', win32.join(home, 'AppData', 'Roaming'))
  fill('LOCALAPPDATA', win32.join(home, 'AppData', 'Local'))
  fill('TEMP', win32.join(get('LOCALAPPDATA'), 'Temp'))
  fill('TMP', get('TEMP'))
  fill('USERNAME', userName())
  fill(
    'PATH',
    [
      system32,
      root,
      win32.join(system32, 'Wbem'),
      win32.join(system32, 'WindowsPowerShell', 'v1.0'),
      win32.join(system32, 'OpenSSH')
    ].join(win32.delimiter)
  )
  return env
}

/** The variables `childEnv` had to add: what the worker's own environment lacks. */
export function filledEnv(base = process.env, platform = process.platform, home = homedir()) {
  const before = new Set(
    Object.keys(base)
      .filter((key) => base[key])
      .map((key) => (platform === 'win32' ? key.toUpperCase() : key))
  )
  return Object.keys(childEnv(base, platform, home))
    .filter((key) => !before.has(platform === 'win32' ? key.toUpperCase() : key))
    .sort()
}

/** On Windows the first ssh.exe on PATH, as a terminal would pick, else the OpenSSH
 *  client that ships with Windows. Named outright so the log can say which one ran. */
export function resolveSsh(env = process.env, platform = process.platform, exists = existsSync) {
  if (platform !== 'win32') return 'ssh'
  const pathKey = envName(env, 'PATH')
  const dirs = String(pathKey === undefined ? '' : env[pathKey])
    .split(win32.delimiter)
    .filter(Boolean)
  for (const dir of dirs) {
    const candidate = win32.join(dir, 'ssh.exe')
    if (exists(candidate)) return candidate
  }
  const rootKey = envName(env, 'SystemRoot')
  const root = (rootKey === undefined ? '' : env[rootKey]) || 'C:\\Windows'
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

/** The last `count` lines that say something, each cut to a readable length. */
export function tailLines(text, count, width = 200) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/ExperimentalWarning|--trace-warnings/.test(line))
    .slice(-count)
    .map((line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line))
}

/** What ssh (or the remote side) said, for the panel: stderr, else stdout. */
function saidBy(run) {
  const lines = tailLines(run.stderr, 3)
  return (lines.length > 0 ? lines : tailLines(run.stdout, 2)).join(' / ').slice(0, 400)
}

function exitText(run) {
  if (run.signal) return `シグナル ${run.signal}`
  return `終了コード ${run.code ?? '-'}`
}

/** What went wrong with one ssh run, in words the person can act on; null when it worked. */
export function readerError(run) {
  const { spawnError, timedOut, code, stdout = '', stderr = '' } = run
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
  const said = saidBy(run)
  // 255 is ssh's own failure; anything else is the remote command's exit status.
  if (code === 255) {
    return fail(
      'ssh_failed',
      said
        ? `SSH で接続できません（${exitText(run)}）: ${said}`
        : `SSH で接続できません（${exitText(run)}、ssh からのメッセージなし）`
    )
  }
  return fail('reader_failed', `サーバー側の読み取りに失敗しました（${exitText(run)}）${said ? `: ${said}` : ''}`)
}

/**
 * One ssh run as log lines: which binary, the exact arguments, how it ended and what it
 * printed. The log stays on this machine, so the target is written as configured.
 * Environment variables are listed by name only.
 */
export function describeRun(run, label = 'ssh') {
  const lines = [
    `${label}: ${exitText(run)}${run.timedOut ? ' (タイムアウト)' : ''} ${run.ms ?? '-'}ms ssh=${run.ssh}` +
      (run.spawnError ? ` spawn=${run.spawnError.code ?? ''} ${run.spawnError.message}` : ''),
    `${label} args: ${JSON.stringify(run.args)}`,
    `${label} stdin: ${run.stdinBytes === null ? 'なし' : `${run.stdinBytes} bytes`}`
  ]
  const stderr = tailLines(run.stderr, 12)
  const stdout = tailLines(run.stdout, 4)
  lines.push(`${label} stderr: ${stderr.length > 0 ? stderr.join(' ⏎ ') : '(空)'}`)
  lines.push(`${label} stdout: ${stdout.length > 0 ? stdout.join(' ⏎ ') : '(空)'}`)
  lines.push(`${label} env: 補った変数=[${(run.filledEnv ?? []).join(',')}] 渡した変数=[${(run.envNames ?? []).join(',')}]`)
  return lines.map((line) => line.slice(0, 4000))
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

/**
 * Runs ssh once and resolves with everything about the run, whether or not it worked:
 * the binary, the arguments, exit code or signal, output and timing. `input` is written
 * to its stdin; without one ssh gets no stdin at all.
 */
function runSsh(args, { input = null, timeoutMs = SSH_TIMEOUT_MS } = {}) {
  const env = childEnv()
  const ssh = resolveSsh(env)
  const started = Date.now()
  const run = {
    ssh,
    args,
    code: null,
    signal: null,
    spawnError: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    ms: 0,
    stdinBytes: input === null ? null : Buffer.byteLength(input),
    filledEnv: filledEnv(),
    envNames: Object.keys(env).sort()
  }
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(Object.assign(run, outcome, { ms: Date.now() - started }))
    }
    let child
    try {
      child = spawn(ssh, args, {
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe']
      })
    } catch (spawnError) {
      finish({ spawnError })
      return
    }
    children.add(child)
    timer = setTimeout(() => {
      run.timedOut = true
      killTree(child)
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (run.stdout.length < 8 * 1024 * 1024) run.stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (run.stderr.length < 64 * 1024) run.stderr += chunk
    })
    child.on('error', (spawnError) => {
      children.delete(child)
      finish({ spawnError })
    })
    child.on('close', (code, signal) => {
      children.delete(child)
      finish({ code, signal })
    })
    if (input !== null) {
      // ssh that fails to connect closes stdin before the script is written.
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
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

/** → the reader's result. A failure carries the run (`error.run`) for the log. */
async function runReader(settings, input, timeoutMs = SSH_TIMEOUT_MS) {
  const run = await runSsh(buildSshArgs(settings), { input: readerPayload(input, readerScript()), timeoutMs })
  const error = readerError(run)
  if (error) {
    error.run = run
    throw error
  }
  return parseReaderOutput(run.stdout)
}

const ECHO_MARK = 'AGENT_METER_ECHO'
const STDIN_MARK = 'AGENT_METER_STDIN'
const TEST_STEP_MS = 15_000

/**
 * The connection test: the same ssh, arguments and environment as a normal read, one
 * step at a time, so a failure says which part breaks. A step that fails is run once
 * more with `ssh -v`, whose trace usually names the cause. Everything goes to the log.
 */
async function testConnection(orca, settings) {
  const env = childEnv()
  const report = { ok: false, ssh: resolveSsh(env), version: '', filledEnv: filledEnv(), steps: [] }
  const say = (lines) => {
    for (const line of lines) orca.log(`test ${line}`)
  }
  if (!settings.sshTarget) {
    report.steps.push({ name: '設定', ok: false, detail: 'SSH 接続先が未設定です' })
    return report
  }
  try {
    buildSshArgs(settings)
  } catch (error) {
    report.steps.push({ name: '設定', ok: false, detail: error.message })
    return report
  }

  const version = await runSsh(['-V'], { timeoutMs: TEST_STEP_MS })
  report.version = tailLines(`${version.stderr}\n${version.stdout}`, 1)[0] ?? ''
  say(describeRun(version, 'ssh -V'))

  const step = async (name, command, { input = null, passed }) => {
    const run = await runSsh(buildSshArgs(settings, command), { input, timeoutMs: TEST_STEP_MS })
    say(describeRun(run, name))
    const result = { name, ok: false, ms: run.ms, detail: '' }
    const error = run.spawnError || run.timedOut ? readerError(run) : null
    if (!error && run.code === 0 && passed(run)) {
      result.ok = true
    } else {
      result.detail = error
        ? error.message
        : String(run.stderr).includes(NODE_MISSING)
          ? 'サーバーに Node.js が見つかりません'
          : `${exitText(run)}${saidBy(run) ? `: ${saidBy(run)}` : '、メッセージなし'}`
      if (!run.spawnError) {
        const verbose = await runSsh(buildSshArgs(settings, command, ['-v']), { input, timeoutMs: TEST_STEP_MS })
        say(describeRun(verbose, `${name} (-v)`))
        result.trace = tailLines(verbose.stderr, 12)
      }
    }
    report.steps.push(result)
    return result.ok
  }

  const ok =
    (await step('接続', `echo ${ECHO_MARK}`, { passed: (run) => run.stdout.includes(ECHO_MARK) })) &&
    (await step('標準入力', 'cat', { input: `${STDIN_MARK}\n`, passed: (run) => run.stdout.includes(STDIN_MARK) })) &&
    (await step('node の検出', buildBootstrap(settings.remoteNode, '--version'), {
      passed: (run) => /v\d+\.\d+/.test(run.stdout)
    })) &&
    (await step('読み取り', buildBootstrap(settings.remoteNode), {
      input: readerPayload({ period: settings.period, agents: [] }, readerScript()),
      passed: (run) => parseReaderOutput(run.stdout)?.ok === true
    }))
  report.ok = ok
  return report
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
        const detail = tailLines(stderr, 1)[0] || tailLines(stdout, 1)[0] || error?.message || 'unexpected output'
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
        title: cleanTitle(agent.displayName || agent.taskTitle),
        updatedAt: Number(agent.updatedAt) || 0
      })
    }
  }
  return agents
}

function cleanTitle(value) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

/**
 * Several agents in one workspace would be rows with the same name, so each gets a
 * `sub`: its title when Orca has one (the agent's own, else its terminal's), and a
 * number otherwise. Numbers follow the pane key, which does not change while the agent
 * lives, so a row keeps its number from one refresh to the next. An agent alone in its
 * workspace gets none.
 */
export function labelAgents(agents, terminalTitles = new Map()) {
  const byWorkspace = new Map()
  for (const agent of agents) {
    const list = byWorkspace.get(agent.cwd) ?? []
    list.push(agent)
    byWorkspace.set(agent.cwd, list)
  }
  const subs = new Map()
  for (const list of byWorkspace.values()) {
    if (list.length < 2) continue
    const ordered = [...list].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    const titles = ordered.map((agent) => agent.title || cleanTitle(terminalTitles.get(agent.id)))
    ordered.forEach((agent, index) => {
      const title = titles[index]
      const shared = title !== '' && titles.filter((other) => other === title).length > 1
      subs.set(agent.id, title === '' ? `#${index + 1}` : shared ? `${title} #${index + 1}` : title)
    })
  }
  return agents.map((agent) => ({ ...agent, sub: subs.get(agent.id) ?? '' }))
}

/** `orca terminal list --json` → pane key (`tabId:leafId`) → terminal title, where set. */
export function terminalTitles(listed) {
  const titles = new Map()
  for (const terminal of listed?.terminals ?? []) {
    if (typeof terminal?.title !== 'string' || terminal.title.trim() === '') continue
    if (typeof terminal.tabId !== 'string' || typeof terminal.leafId !== 'string') continue
    titles.set(`${terminal.tabId}:${terminal.leafId}`, terminal.title)
  }
  return titles
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
      sub: known?.sub ?? '',
      // Sessions Orca does not list (DSH) are told apart below, by directory and key.
      unlisted: row.id === null ? { where: `${row.agent}\u0000${row.cwd ?? ''}`, key: String(row.key ?? '') } : null,
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
  const unlisted = new Map()
  for (const row of list.flatMap((group) => group.rows)) {
    if (!row.unlisted) continue
    const rows = unlisted.get(row.unlisted.where) ?? []
    rows.push(row)
    unlisted.set(row.unlisted.where, rows)
  }
  for (const rows of unlisted.values()) {
    if (rows.length < 2) continue
    rows.sort((left, right) => left.unlisted.key.localeCompare(right.unlisted.key))
    rows.forEach((row, index) => (row.sub = `#${index + 1}`))
  }
  for (const group of list) {
    for (const row of group.rows) delete row.unlisted
    group.rows.sort(
      (left, right) =>
        Number(right.working) - Number(left.working) ||
        (right.percent ?? -1) - (left.percent ?? -1) ||
        left.name.localeCompare(right.name) ||
        left.sub.localeCompare(right.sub)
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
  const fullest = groups
    .flatMap((group) => group.rows)
    .filter((row) => row.percent !== null)
    .map((row) => ({ percent: row.percent, name: row.sub ? `${row.name} ${row.sub}` : row.name }))
    .sort((left, right) => right.percent - left.percent)
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

/** The ids of `contributes.statusBarItems`. */
export const STATUS_ITEMS = ['speed', 'context']

/**
 * The two status bar items. Orca gives an item one colour, so the speed and the context
 * are separate items: a full context must not paint the speed red.
 *
 * - `speed`: the median tokens per second. Neutral; a warning only when the read failed.
 * - `context`: the fullest context among live agents, amber from 70% and red from 90%,
 *   with the fullest agents in its tooltip. Hidden while there is no percentage to show.
 */
export function statusBarItems(snapshot) {
  const hidden = { visible: false }
  if (!snapshot.configured) {
    return {
      speed: { text: '⚡ 未設定', tone: 'neutral', tooltip: 'Agent Meter: 設定で SSH 接続先を入れてください', visible: true },
      context: hidden
    }
  }
  const { tokPerSec, fullest } = summarize(snapshot.groups)
  const speedLines = snapshot.groups
    .filter((group) => group.tokPerSec !== null)
    .map(
      (group) =>
        `${AGENT_LABELS[group.agent] ?? group.agent} ${shortModel(group.model)} ` +
        `${group.estimated ? '≈' : ''}${Math.round(group.tokPerSec)} tok/s`
    )
  const speed = snapshot.error
    ? { text: '⚡ 取得失敗', tone: 'warning', tooltip: oneLine(`Agent Meter: ${snapshot.error.message}`, 256) }
    : {
        text: tokPerSec === null ? '⚡ —' : `⚡ ${Math.round(tokPerSec)} tok/s`,
        tone: 'neutral',
        tooltip: oneLine(
          `Agent Meter 出力速度（${PERIOD_LABELS[snapshot.period] ?? snapshot.period}）: ${speedLines.join(' / ') || 'データなし'}`,
          256
        )
      }
  if (fullest.length === 0) return { speed: { ...speed, visible: true }, context: hidden }
  const percent = fullest[0].percent
  const agents = fullest.slice(0, 6).map((entry) => `${entry.name} ${Math.round(entry.percent)}%`)
  return {
    speed: { ...speed, visible: true },
    context: {
      text: `◔ ${Math.round(percent)}%`,
      tone: percent >= DANGER_PERCENT ? 'danger' : percent >= WARN_PERCENT ? 'warning' : 'neutral',
      // After a failed read these are the figures of the last good one.
      tooltip: oneLine(`Agent Meter コンテキスト${snapshot.error ? '（前回の値）' : ''}: ${agents.join(' / ')}`, 256),
      visible: true
    }
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

/** The settings as last read, kept for when Orca refuses to hand them out. */
let knownSettings = {}

async function readSettings(orca) {
  const settings = { ...DEFAULTS, ...knownSettings }
  let refused = false
  for (const key of Object.keys(DEFAULTS)) {
    try {
      const value = await orca.settings.get(key)
      settings[key] = value !== undefined && value !== null ? value : DEFAULTS[key]
      knownSettings[key] = settings[key]
    } catch (error) {
      // Keep what was last read, else the default.
      if (isConsentError(error)) refused = true
    }
  }
  noteConsent(orca, 'settings', refused)
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
/** Per status bar item, the update last sent, so an unchanged one is not sent again. */
let lastStatusKeys = {}
/** The snapshot last published. */
let last = null
let lastKey = ''
let lastLogLine = ''
/** The failed ssh run last written to the log, so a failure that repeats is logged once. */
let lastRunKey = ''
/** When a panel last asked; 0 once it said it was hidden. */
let panelSeenAt = 0
/** Panel-only mode with no panel open: no timer runs until a panel asks again. */
let paused = false
let environment = { arg: 'local', label: 'local' }
let terminals = { at: 0, environment: '', handles: new Map(), titles: new Map() }

function hostHas(orca, method, sinceMinor) {
  if (typeof orca.host?.has === 'function') return orca.host.has(method)
  return orca.api.major > 1 || orca.api.minor >= sinceMinor
}

/** Orca refusing a call because the plugin's approval no longer matches its code or
 *  capabilities, as after a development reload that changed them. */
export function isConsentError(error) {
  return error?.code === 'consent_required' || /not enabled with current consent/i.test(String(error?.message ?? ''))
}

/** Which kinds of call Orca is refusing for want of approval. */
const refusedBy = { statusBar: false, settings: false, post: false }
let lastStatusError = ''

function consentRequired() {
  return refusedBy.statusBar || refusedBy.settings || refusedBy.post
}

/**
 * Records whether one kind of call was refused. Refusals repeat on every refresh until
 * the person approves again, so the log gets one line when they start and one when they
 * stop, and the panel is told so it can say what to do.
 */
function noteConsent(orca, source, refused) {
  if (active !== orca) return
  const before = consentRequired()
  refusedBy[source] = refused
  const now = consentRequired()
  if (now === before) return
  orca.log(
    now
      ? 'consent_required: Orca がこのプラグインを現在の承認で有効にしていません。承認をやり直してください（解消するまでこの行は繰り返しません）'
      : 'consent: 承認が戻りました'
  )
  if (!last) return
  last = { ...last, consentRequired: now }
  lastKey = contentKey(last)
  post(orca, 'snapshot', last)
}

/** Sends to open panels. A refusal is recorded, never thrown or logged over and over. */
function post(orca, name, data) {
  const failed = (error) => {
    if (isConsentError(error)) noteConsent(orca, 'post', true)
    else logOnce(orca, `post ERR ${error?.message ?? error}`)
  }
  try {
    const sent = orca.panels.post(name, data)
    if (sent && typeof sent.then === 'function') sent.then(() => noteConsent(orca, 'post', false), failed)
    else noteConsent(orca, 'post', false)
  } catch (error) {
    failed(error)
  }
}

function updateStatusBar(orca, id, patch) {
  if (!hostHas(orca, 'statusBar.update', 2)) return
  const key = JSON.stringify(patch)
  if (key === lastStatusKeys[id]) return
  lastStatusKeys[id] = key
  orca.host.call('statusBar.update', { id, ...patch }).then(
    () => {
      lastStatusError = ''
      noteConsent(orca, 'statusBar', false)
    },
    (error) => {
      // Tried again on the next refresh, so it recovers by itself once the cause is gone.
      delete lastStatusKeys[id]
      if (isConsentError(error)) {
        noteConsent(orca, 'statusBar', true)
        return
      }
      const line = `statusBar.update ERR ${error.code ?? '-'} ${error.message}`
      if (line === lastStatusError) return
      lastStatusError = line
      orca.log(line)
    }
  )
}

function logOnce(orca, line) {
  // The worker polls all day; only say what changed.
  if (line === lastLogLine) return
  lastLogLine = line
  orca.log(line)
}

/** Writes a failed ssh run to the log in full, once per distinct failure. */
function logRun(orca, run) {
  if (!run) return
  const lines = describeRun(run)
  const key = lines.filter((line) => !/^ssh: /.test(line)).join('\n') + `|${run.code}|${run.signal}`
  if (key === lastRunKey) return
  lastRunKey = key
  for (const line of lines) orca.log(line)
}

/** Updates both status bar items; with `shown` false (panel-only mode) both are hidden. */
function showStatusBar(orca, snapshot, shown) {
  const items = shown && snapshot ? statusBarItems(snapshot) : {}
  for (const id of STATUS_ITEMS) {
    // Every field goes out each time: an omitted one would keep its old value.
    updateStatusBar(orca, id, items[id] ?? { visible: false })
  }
}

function publish(orca, built, settings) {
  if (active !== orca) return
  const snapshot = { ...built, consentRequired: consentRequired() }
  last = snapshot
  showStatusBar(orca, snapshot, settings.displayMode !== 'panel')
  const key = contentKey(snapshot)
  if (key !== lastKey) {
    lastKey = key
    post(orca, 'snapshot', snapshot)
  } else {
    // Nothing changed; the panel only needs to know the read happened.
    post(orca, 'tick', { fetchedAt: snapshot.fetchedAt })
  }
}

/** → `{ handles, titles }` of the server's terminals, by pane key. */
async function readTerminals(target) {
  if (terminals.environment === target && Date.now() - terminals.at < TERMINALS_TTL_MS) return terminals
  const listed = await runCli(['terminal', 'list', '--json', '--environment', target, '--limit', '500'])
  terminals = {
    at: Date.now(),
    environment: target,
    handles: terminalHandles(listed),
    titles: terminalTitles(listed)
  }
  return terminals
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
      const known = await readTerminals(environment.arg).catch(() => ({ handles: new Map(), titles: new Map() }))
      handles = known.handles
      agents = labelAgents(flattenAgents(listed), known.titles)
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
    lastRunKey = ''
    const groups = buildGroups(reader, agents, handles)
    logOnce(
      orca,
      `state models=${(reader.models ?? []).length} agents=${(reader.agents ?? []).length} node=${reader.node} truncated=${reader.truncated === true}`
    )
    return { ...base, groups }
  } catch (error) {
    logOnce(orca, `state ERR ${error.code ?? '-'} ${error.message}`)
    logRun(orca, error.run)
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

/**
 * A visible panel asks again every 20 s (HEARTBEAT_MS in panel/index.html) and says
 * when it is hidden. A frame that goes away without saying so is noticed here: two
 * missed beats mean it is closed.
 */
export const PANEL_ALIVE_MS = 50_000

/** Whether anything on screen needs the server read: the status bar item always does,
 *  a panel only while it is open. */
export function shouldPoll(displayMode, seenAt, now) {
  return displayMode !== 'panel' || now - seenAt < PANEL_ALIVE_MS
}

function schedule(orca) {
  clearTimeout(timer)
  if (active !== orca || paused) return
  timer = setTimeout(() => void tick(orca), pollMs)
}

async function tick(orca) {
  try {
    const settings = await readSettings(orca)
    pollMs = settings.refreshSeconds * 1000
    if (shouldPoll(settings.displayMode, panelSeenAt, Date.now())) {
      paused = false
      await refresh(orca)
    } else {
      // Panel-only mode with no panel open: nothing is on screen, so nothing is read
      // and no timer is left running. A panel that opens, or a setting, starts it again.
      paused = true
      showStatusBar(orca, null, false)
    }
  } catch (error) {
    orca.log(`tick ERR ${error.message}`)
  }
  schedule(orca)
}

/** A panel is on screen: make sure the server is being read. */
function panelSeen(orca) {
  panelSeenAt = Date.now()
  if (!paused) return
  paused = false
  clearTimeout(timer)
  void tick(orca)
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
  lastStatusKeys = {}
  lastStatusError = ''
  lastLogLine = ''
  lastRunKey = ''
  knownSettings = {}
  refusedBy.statusBar = refusedBy.settings = refusedBy.post = false
  panelSeenAt = 0
  paused = false

  // A panel asks when it opens and while it stays visible. It gets what is already
  // known at once; a stale answer is followed by a post when the read finishes.
  orca.panels.handle('snapshot.get', async () => {
    panelSeen(orca)
    if (!last) return refresh(orca)
    if (Date.now() - last.fetchedAt > 2 * pollMs) void refresh(orca)
    return last
  })
  // Best effort: a frame that is torn down may not get to say so, which the missed
  // heartbeats cover. With several panels open, the next beat of another one resumes.
  orca.panels.handle('panel.hidden', () => {
    panelSeenAt = 0
    return { ok: true }
  })
  orca.panels.handle('agent.focus', (input) => focusAgent(input?.id))
  // Also reachable without the panel: `orca plugin dev request <folder> connection.test`.
  orca.panels.handle('connection.test', async () => testConnection(orca, await readSettings(orca)))

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
  paused = false
  clearTimeout(timer)
  timer = null
  for (const child of children) killTree(child)
  children.clear()
}
