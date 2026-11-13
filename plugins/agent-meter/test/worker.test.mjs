import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { SENTINEL as READER_SENTINEL } from '../reader/reader.mjs'
import {
  DEFAULTS,
  SENTINEL,
  STATUS_ITEMS,
  buildBootstrap,
  buildGroups,
  buildSshArgs,
  checkTarget,
  childEnv,
  contentKey,
  describeRun,
  filledEnv,
  flattenAgents,
  isConsentError,
  labelAgents,
  parseReaderOutput,
  pickEnvironment,
  readerError,
  readerPayload,
  resolveSsh,
  statusBarItems,
  summarize,
  tailLines,
  terminalHandles,
  terminalTitles
} from '../worker/main.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'))
const readerSource = readFileSync(join(here, '..', 'reader', 'reader.mjs'), 'utf8')
const manifest = JSON.parse(readFileSync(join(here, '..', 'orca-plugin.json'), 'utf8'))

// --- SSH command -----------------------------------------------------------------

test('the worker and the reader agree on the sentinel', () => {
  assert.equal(SENTINEL, READER_SENTINEL)
})

test('ssh target: an option-looking or spaced value is refused', () => {
  for (const good of ['user@host', 'host', 'dev-box', 'user@192.0.2.10', 'user@[2001:db8::1]', 'host.example']) {
    assert.equal(checkTarget(good), good)
  }
  for (const bad of ['-oProxyCommand=x', 'user@host -p 22', '', 'a;b', 'user@host\n']) {
    assert.throws(() => checkTarget(bad), { code: 'invalid_params' })
  }
})

test('bootstrap: one sh -c word with nothing a login shell or Windows quoting can reinterpret', () => {
  for (const remoteNode of ['', '/opt/node/bin/node', '~/.local/bin/node']) {
    const command = buildBootstrap(remoteNode)
    assert.match(command, /^sh -c '[^']+'$/)
    assert.equal(/["\\`!\n]/.test(command), false)
    assert.match(command, /exec \$n --input-type=module - --json/)
  }
  assert.match(buildBootstrap('/opt/node/bin/node'), /; n=\/opt\/node\/bin\/node; /)
  // The session starts in the home directory, so `~/` becomes a relative path.
  assert.match(buildBootstrap('~/.local/bin/node'), /; n=\.local\/bin\/node; /)
  for (const bad of ['/path with space/node', "/a'b", '$(reboot)', '/a;b', '-e', '/a"b']) {
    assert.throws(() => buildBootstrap(bad), { code: 'invalid_params' })
  }
})

test('ssh args: batch mode, optional identity, then target and command', () => {
  const args = buildSshArgs({ sshTarget: ' user@host ', identityFile: '', remoteNode: '' })
  // The same words that work typed into a terminal: no `--`, nothing after the command.
  assert.deepEqual(args, ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'user@host', buildBootstrap('')])
  const withKey = buildSshArgs({ sshTarget: 'user@host', identityFile: '/keys/id_test', remoteNode: '' })
  assert.deepEqual(withKey.slice(5, 8), ['-i', '/keys/id_test', 'user@host'])
  assert.deepEqual(buildSshArgs({ sshTarget: 'user@host' }, 'echo ok', ['-v']), [
    '-v',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    'user@host',
    'echo ok'
  ])
  assert.throws(() => buildSshArgs({ sshTarget: '-oProxyCommand=x' }), { code: 'invalid_params' })
  assert.match(buildBootstrap('', '--version'), /exec \$n --version'$/)
})

/** How Node (libuv) turns one argument into command-line text on Windows. */
function windowsQuote(arg) {
  if (arg.length === 0) return '""'
  if (!/[ \t"]/.test(arg)) return arg
  if (!/["\\]/.test(arg)) return `"${arg}"`
  let out = '"'
  let backslashes = 0
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1
    } else if (char === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
    } else {
      out += '\\'.repeat(backslashes) + char
      backslashes = 0
    }
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`
}

/** How a Windows program (the C runtime) splits command-line text back into arguments. */
function windowsSplit(line) {
  const args = []
  let current = ''
  let quoted = false
  let started = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\') {
      let count = 0
      while (line[index] === '\\') {
        count += 1
        index += 1
      }
      if (line[index] === '"') {
        current += '\\'.repeat(count >> 1)
        if (count % 2 === 1) current += '"'
        else quoted = !quoted
      } else {
        current += '\\'.repeat(count)
        index -= 1
      }
      started = true
    } else if (char === '"') {
      quoted = !quoted
      started = true
    } else if ((char === ' ' || char === '\t') && !quoted) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

test('ssh args survive the Windows command line unchanged', () => {
  const cases = [
    buildSshArgs({ sshTarget: 'user@host' }),
    buildSshArgs({ sshTarget: 'user@host', remoteNode: '~/.local/bin/node' }, undefined, ['-v']),
    buildSshArgs({ sshTarget: 'user@host', identityFile: 'C:\\Users\\some user\\.ssh\\id_test' }, 'echo ok'),
    buildSshArgs({ sshTarget: 'user@host', identityFile: 'C:\\keys dir\\' }, 'cat')
  ]
  for (const args of cases) {
    const line = ['ssh.exe', ...args].map(windowsQuote).join(' ')
    assert.deepEqual(windowsSplit(line), ['ssh.exe', ...args])
  }
  // The command is one word wrapped in plain double quotes: nothing in it needs escaping.
  const bootstrap = buildBootstrap('')
  assert.equal(windowsQuote(bootstrap), `"${bootstrap}"`)
})

test('ssh binary: PATH first on Windows, then the bundled OpenSSH', () => {
  assert.equal(resolveSsh({}, 'linux'), 'ssh')
  const found = (wanted) => (file) => file === wanted
  const inPath = 'X:\\tools\\ssh.exe'
  assert.equal(resolveSsh({ Path: 'X:\\other;X:\\tools' }, 'win32', found(inPath)), inPath)
  const bundled = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
  assert.equal(resolveSsh({ PATH: 'X:\\tools' }, 'win32', found(bundled)), bundled)
  assert.equal(resolveSsh({}, 'win32', () => false), 'ssh.exe')
})

test('child env: restores what a reduced worker environment lacks', () => {
  const posix = childEnv({}, 'linux', '/home/someone')
  assert.deepEqual(posix, { HOME: '/home/someone', PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin' })
  assert.equal(childEnv({ HOME: '/h', PATH: '/p' }, 'linux').PATH, '/p')

  // What OpenSSH for Windows needs to start at all, and what a normal session has.
  const windows = childEnv({}, 'win32', 'C:\\Users\\someone')
  assert.deepEqual(
    {
      SystemRoot: windows.SystemRoot,
      SystemDrive: windows.SystemDrive,
      ProgramData: windows.ProgramData,
      ALLUSERSPROFILE: windows.ALLUSERSPROFILE,
      ComSpec: windows.ComSpec,
      USERPROFILE: windows.USERPROFILE,
      HOMEDRIVE: windows.HOMEDRIVE,
      HOMEPATH: windows.HOMEPATH,
      APPDATA: windows.APPDATA,
      LOCALAPPDATA: windows.LOCALAPPDATA,
      TEMP: windows.TEMP
    },
    {
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'C:',
      ProgramData: 'C:\\ProgramData',
      ALLUSERSPROFILE: 'C:\\ProgramData',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      USERPROFILE: 'C:\\Users\\someone',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\someone',
      APPDATA: 'C:\\Users\\someone\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
      TEMP: 'C:\\Users\\someone\\AppData\\Local\\Temp'
    }
  )
  assert.match(windows.PATH, /C:\\Windows\\System32\\OpenSSH$/)
  assert.ok(filledEnv({}, 'win32', 'C:\\Users\\someone').includes('ProgramData'))

  // Present values are kept, whatever their case, and a drive other than C: is followed.
  const kept = childEnv(
    { SYSTEMROOT: 'D:\\Windows', programdata: 'E:\\Data', Path: 'X:\\tools', USERPROFILE: 'D:\\Users\\someone' },
    'win32',
    'D:\\Users\\someone'
  )
  assert.equal(kept.SYSTEMROOT, 'D:\\Windows')
  assert.equal('SystemRoot' in kept, false)
  assert.equal(kept.programdata, 'E:\\Data')
  assert.equal('ProgramData' in kept, false)
  assert.equal(kept.Path, 'X:\\tools')
  assert.equal('PATH' in kept, false)
  assert.equal(kept.SystemDrive, 'D:')
  assert.equal(kept.ALLUSERSPROFILE, 'E:\\Data')
  const filled = filledEnv({ SYSTEMROOT: 'D:\\Windows', Path: 'X:\\tools' }, 'win32', 'D:\\Users\\someone')
  assert.equal(filled.includes('PATH') || filled.includes('Path') || filled.includes('SystemRoot'), false)
  assert.ok(filled.includes('ProgramData') && filled.includes('USERPROFILE'))
  assert.deepEqual(filledEnv({ HOME: '/h', PATH: '/p' }, 'linux', '/h'), [])
})

test('reader output: the sentinel line wins over rc-file noise', () => {
  const stdout = `welcome banner\r\n{"not":"ours"}\n${SENTINEL}{"ok":true,"models":[]}\ntrailing\n`
  assert.deepEqual(parseReaderOutput(stdout), { ok: true, models: [] })
  assert.equal(parseReaderOutput('nothing here'), null)
  assert.equal(parseReaderOutput(`${SENTINEL}{broken`), null)
})

test('reader errors: each failure names what to do', () => {
  const ok = `${SENTINEL}{"ok":true}\n`
  assert.equal(readerError({ code: 0, stdout: ok, stderr: '' }), null)
  assert.equal(readerError({ spawnError: { code: 'ENOENT', message: 'x' }, stdout: '', stderr: '' }).code, 'ssh_missing')
  assert.equal(readerError({ timedOut: true, code: null, stdout: '', stderr: '' }).code, 'timeout')
  assert.equal(
    readerError({ code: 127, stdout: '', stderr: 'AGENT_METER_NODE_NOT_FOUND\n' }).code,
    'node_missing'
  )
  const denied = readerError({ code: 255, stdout: '', stderr: 'debug line\nuser@host: Permission denied (publickey).\n' })
  assert.equal(denied.code, 'ssh_failed')
  assert.equal(denied.message, 'SSH で接続できません（終了コード 255）: debug line / user@host: Permission denied (publickey).')
  // ssh ended without a word: say so, with the code, instead of an empty reason.
  const silent = readerError({ code: 255, stdout: '', stderr: '' })
  assert.equal(silent.message, 'SSH で接続できません（終了コード 255、ssh からのメッセージなし）')
  // Nothing on stderr: whatever came on stdout is the best clue.
  assert.match(readerError({ code: 255, stdout: 'banner text\n', stderr: '' }).message, /: banner text$/)
  const failed = readerError({ code: 0, stdout: `${SENTINEL}{"ok":false,"error":"boom"}\n`, stderr: '' })
  assert.match(failed.message, /boom/)
  const remote = readerError({ code: 1, stdout: '', stderr: 'SyntaxError: x\n' })
  assert.deepEqual({ code: remote.code, message: remote.message }, {
    code: 'reader_failed',
    message: 'サーバー側の読み取りに失敗しました（終了コード 1）: SyntaxError: x'
  })
  assert.match(readerError({ code: null, signal: 'SIGKILL', stdout: '', stderr: '' }).message, /シグナル SIGKILL/)
})

test('tailLines: the last lines that say something', () => {
  assert.deepEqual(tailLines('a\r\n\n  b  \n(node:1) ExperimentalWarning: x\nc\n', 2), ['b', 'c'])
  assert.deepEqual(tailLines('', 3), [])
  assert.equal(tailLines('x'.repeat(500), 1, 50)[0].length, 50)
})

test('describeRun: the binary, the exact arguments, the exit and the output', () => {
  const lines = describeRun({
    ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    args: ['-T', 'user@host', 'echo ok'],
    code: 255,
    signal: null,
    timedOut: false,
    spawnError: null,
    stdout: '',
    stderr: 'first\nsecond\n',
    ms: 120,
    stdinBytes: 42,
    filledEnv: ['ProgramData'],
    envNames: ['PATH', 'ProgramData']
  })
  assert.deepEqual(lines, [
    'ssh: 終了コード 255 120ms ssh=C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    'ssh args: ["-T","user@host","echo ok"]',
    'ssh stdin: 42 bytes',
    'ssh stderr: first ⏎ second',
    'ssh stdout: (空)',
    'ssh env: 補った変数=[ProgramData] 渡した変数=[PATH,ProgramData]'
  ])
  const empty = describeRun({ ssh: 'ssh', args: [], code: null, signal: 'SIGKILL', timedOut: true, stdout: '', stderr: '', ms: 1, stdinBytes: null })
  assert.equal(empty[0], 'ssh: シグナル SIGKILL (タイムアウト) 1ms ssh=ssh')
  assert.equal(empty[2], 'ssh stdin: なし')
  assert.equal(empty[3], 'ssh stderr: (空)')
})

// --- the bootstrap, run for real ---------------------------------------------------

/** What sshd does with the command: hand the one string to a shell, stdin attached. */
function runAsRemote(command, env, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
}

const posix = process.platform !== 'win32'
const payload = readerPayload({ period: '15m', agents: [] }, readerSource)
const systemNode = ['/usr/bin/node', '/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node'].some((file) => existsSync(file))
const plainPath = /^[A-Za-z0-9_.~/][A-Za-z0-9_.~/@+-]*$/.test(process.execPath)

test('bootstrap: runs the piped reader with the configured node', { skip: !posix || !plainPath }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-meter-remote-'))
  try {
    const result = await runAsRemote(buildBootstrap(process.execPath), { HOME: home, PATH: '/usr/bin:/bin' }, payload)
    assert.equal(result.code, 0, result.stderr)
    const parsed = parseReaderOutput(`motd line\n${result.stdout}`)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.period, '15m')
    assert.deepEqual(parsed.agents, [])
    assert.equal(readerError({ code: result.code, stdout: result.stdout, stderr: result.stderr }), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('bootstrap: finds a node that is not on PATH', { skip: !posix || systemNode }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-meter-remote-'))
  try {
    mkdirSync(join(home, '.volta/bin'), { recursive: true })
    symlinkSync(process.execPath, join(home, '.volta/bin/node'))
    const result = await runAsRemote(buildBootstrap(''), { HOME: home, PATH: '/usr/bin:/bin' }, payload)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(parseReaderOutput(result.stdout).ok, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('bootstrap: picks the newest nvm version', { skip: !posix || systemNode }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-meter-remote-'))
  try {
    // Only the newest one is a real node; picking another would fail to run.
    for (const version of ['v9.11.2', 'v18.20.4']) {
      mkdirSync(join(home, '.nvm/versions/node', version, 'bin'), { recursive: true })
      symlinkSync('/bin/false', join(home, '.nvm/versions/node', version, 'bin/node'))
    }
    mkdirSync(join(home, '.nvm/versions/node/v100.0.0/bin'), { recursive: true })
    symlinkSync(process.execPath, join(home, '.nvm/versions/node/v100.0.0/bin/node'))
    const result = await runAsRemote(buildBootstrap(''), { HOME: home, PATH: '/usr/bin:/bin' }, payload)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(parseReaderOutput(result.stdout).ok, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('bootstrap: says so when there is no node', { skip: !posix || systemNode }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-meter-remote-'))
  try {
    const missing = await runAsRemote(buildBootstrap(''), { HOME: home, PATH: '/usr/bin:/bin' }, payload)
    assert.equal(missing.code, 127)
    assert.equal(readerError({ code: missing.code, stdout: missing.stdout, stderr: missing.stderr }).code, 'node_missing')
    const wrong = await runAsRemote(buildBootstrap('/nonexistent/node'), { HOME: home, PATH: '/usr/bin:/bin' }, payload)
    assert.equal(readerError({ code: wrong.code, stdout: wrong.stdout, stderr: wrong.stderr }).code, 'node_missing')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// --- orca CLI output ------------------------------------------------------------------

test('environment: a name the CLI cannot take falls back to its id', () => {
  const environments = [
    { id: 'env-1', name: 'my server' },
    { id: 'env-2', name: 'dev' }
  ]
  assert.deepEqual(pickEnvironment('dev', []), { arg: 'dev', label: 'dev' })
  assert.deepEqual(pickEnvironment('', environments), { arg: 'env-1', label: 'my server' })
  assert.deepEqual(pickEnvironment('', []), { arg: 'local', label: 'local' })
  assert.deepEqual(pickEnvironment('my server', environments), { arg: 'env-1', label: 'my server' })
  assert.throws(() => pickEnvironment('no such one', environments), { code: 'invalid_params' })
  assert.throws(
    () => pickEnvironment('twin box', [{ id: 'a', name: 'twin box' }, { id: 'b', name: 'twin box' }]),
    { code: 'invalid_params' }
  )
})

test('worktree ps: known agent kinds with their workspace and title', () => {
  assert.deepEqual(
    flattenAgents(fixture('worktree-ps.json')).map(({ id, type, state, cwd, name, title }) => ({ id, type, state, cwd, name, title })),
    [
      { id: 'tab-1:leaf-1', type: 'claude', state: 'working', cwd: '/work/alpha', name: 'alpha', title: '' },
      { id: 'structured-agent-session-1:pane-1', type: 'codex', state: 'done', cwd: '/work/alpha', name: 'alpha', title: '' },
      { id: 'tab-2:leaf-2', type: 'pi', state: 'idle', cwd: '/work/beta', name: 'beta', title: '' },
      { id: 'tab-5:leaf-b', type: 'claude', state: 'done', cwd: '/work/delta', name: 'develop', title: '' },
      // Whitespace in a title is flattened to one line.
      { id: 'tab-5:leaf-a', type: 'claude', state: 'done', cwd: '/work/delta', name: 'develop', title: 'Fix login flow' },
      { id: 'tab-6:leaf-a', type: 'codex', state: 'done', cwd: '/work/delta', name: 'develop', title: '' }
    ]
  )
  assert.deepEqual(flattenAgents({}), [])
})

test('terminal list: pane key to handle and title, unsafe handles dropped', () => {
  assert.deepEqual([...terminalHandles(fixture('terminal-list.json'))], [
    ['tab-1:leaf-1', 'term_one'],
    ['tab-6:leaf-a', 'term_three']
  ])
  assert.deepEqual([...terminalTitles(fixture('terminal-list.json'))], [['tab-6:leaf-a', 'codex: review']])
})

test('labels: agents sharing a workspace get a title or a number, others none', () => {
  const labelled = labelAgents(flattenAgents(fixture('worktree-ps.json')), terminalTitles(fixture('terminal-list.json')))
  assert.deepEqual(
    labelled.map((agent) => [agent.id, agent.sub]),
    [
      // Two kinds in one workspace are told apart as well.
      ['tab-1:leaf-1', '#2'],
      ['structured-agent-session-1:pane-1', '#1'],
      ['tab-2:leaf-2', ''],
      // Numbered by pane key, not by listing order, so a number stays with its agent.
      ['tab-5:leaf-b', '#2'],
      ['tab-5:leaf-a', 'Fix login flow'],
      ['tab-6:leaf-a', 'codex: review']
    ]
  )
  const agent = (id, title) => ({ id, type: 'claude', state: 'done', cwd: '/work/x', name: 'x', title, updatedAt: 0 })
  // The same title twice says nothing, so the number is added.
  assert.deepEqual(
    labelAgents([agent('b', 'Review'), agent('a', 'Review'), agent('c', 'Other')]).map((entry) => entry.sub),
    ['Review #2', 'Review #1', 'Other']
  )
  assert.deepEqual(labelAgents([agent('a', 'Alone')]).map((entry) => entry.sub), [''])
})

// --- what is shown ------------------------------------------------------------------

const READER = {
  ok: true,
  models: [
    { agent: 'codex', model: 'gpt-test-1', tokPerSec: 40, latest: 44, samples: 12, estimated: true },
    { agent: 'claude', model: 'claude-test-1', tokPerSec: 82.4, latest: 90, samples: 30, estimated: true },
    { agent: 'pi', model: 'local-test-1', tokPerSec: 120, latest: 110, samples: 4, estimated: false }
  ],
  agents: [
    { id: 'tab-1:leaf-1', agent: 'claude', cwd: '/work/alpha', state: 'working', model: 'claude-test-1', contextTokens: 146_000, contextWindow: 200_000, windowEstimated: true },
    { id: 'c2', agent: 'claude', cwd: '/work/beta', state: 'done', model: 'claude-test-1', contextTokens: 180_000, contextWindow: 1_000_000, windowEstimated: true },
    { id: 'structured-agent-session-1:pane-1', agent: 'codex', cwd: '/work/alpha', state: 'done', model: 'gpt-test-1', contextTokens: 50_000, contextWindow: 400_000, windowEstimated: false },
    { id: 'c3', agent: 'claude', cwd: '/work/none', state: 'done', model: null, contextTokens: null, contextWindow: null, windowEstimated: false },
    { id: 'tab-5:leaf-b', agent: 'claude', cwd: '/work/delta', state: 'done', model: 'claude-test-1', contextTokens: 24_000, contextWindow: 200_000, windowEstimated: true },
    { id: 'tab-5:leaf-a', agent: 'claude', cwd: '/work/delta', state: 'done', model: 'claude-test-1', contextTokens: 20_000, contextWindow: 200_000, windowEstimated: true },
    { id: 'tab-6:leaf-a', agent: 'codex', cwd: '/work/delta', state: 'done', model: 'gpt-test-1', contextTokens: 20_000, contextWindow: 400_000, windowEstimated: false },
    { id: null, key: 'session-b', agent: 'dsh', cwd: '/work/gamma', state: 'working', model: 'dsh-test-1', contextTokens: 9000, contextWindow: null, windowEstimated: false }
  ]
}

function snapshotOf(reader, overrides = {}) {
  const titles = terminalTitles(fixture('terminal-list.json'))
  const agents = labelAgents(flattenAgents(fixture('worktree-ps.json')), titles)
  const handles = terminalHandles(fixture('terminal-list.json'))
  return {
    configured: true,
    label: 'user@host',
    period: '1h',
    refreshSeconds: 15,
    fetchedAt: 1,
    error: null,
    notice: null,
    consentRequired: false,
    groups: buildGroups(reader, agents, handles),
    ...overrides
  }
}

test('groups: per model, kinds in a fixed order, agents under their model', () => {
  const groups = snapshotOf(READER).groups
  assert.deepEqual(
    groups.map((group) => [group.agent, group.model, group.tokPerSec, group.rows.map((row) => [row.name, row.sub])]),
    [
      // The three agents of `develop` stay apart: by title where there is one, else by number.
      ['claude', 'claude-test-1', 82.4, [['alpha', '#2'], ['beta', ''], ['develop', '#2'], ['develop', 'Fix login flow']]],
      ['claude', null, null, [['none', '']]],
      ['codex', 'gpt-test-1', 40, [['alpha', '#1'], ['develop', 'codex: review']]],
      ['pi', 'local-test-1', 120, []],
      ['dsh', 'dsh-test-1', null, [['gamma', '']]]
    ]
  )
  const [alpha, beta] = groups[0].rows
  assert.deepEqual(
    { working: alpha.working, percent: alpha.percent, focusable: alpha.focusable, estimated: alpha.windowEstimated },
    { working: true, percent: 73, focusable: true, estimated: true }
  )
  // Not in the terminal list, so there is nothing to focus.
  assert.deepEqual({ working: beta.working, percent: beta.percent, focusable: beta.focusable }, { working: false, percent: 18, focusable: false })
  assert.equal(groups[2].rows[0].focusable, false)
  assert.equal(groups[2].rows[1].focusable, true)
  // No window known: tokens only.
  assert.deepEqual({ tokens: groups[4].rows[0].tokens, percent: groups[4].rows[0].percent }, { tokens: 9000, percent: null })
  assert.equal(groups.flatMap((group) => group.rows).some((row) => 'unlisted' in row), false)
})

test('groups: sessions Orca does not list are numbered by their own key', () => {
  const dsh = (key, tokens) => ({ id: null, key, agent: 'dsh', cwd: '/work/gamma', state: 'idle', model: 'dsh-test-1', contextTokens: tokens, contextWindow: 100_000, windowEstimated: false })
  const groups = buildGroups({ models: [], agents: [dsh('session-b', 50_000), dsh('session-a', 10_000), { ...dsh('session-c', 1000), cwd: '/work/other' }] })
  // Sorted by fullness on screen, numbered by key underneath.
  assert.deepEqual(
    groups[0].rows.map((row) => [row.name, row.sub, row.percent]),
    [
      ['gamma', '#2', 50],
      ['gamma', '#1', 10],
      ['other', '', 1]
    ]
  )
})

test('status bar: speed and context are separate items with their own colour', () => {
  assert.deepEqual(STATUS_ITEMS, ['speed', 'context'])
  const snapshot = snapshotOf(READER)
  const summary = summarize(snapshot.groups)
  assert.equal(summary.tokPerSec, 82.4)
  assert.deepEqual(summary.fullest[0], { percent: 73, name: 'alpha #2' })
  const { speed, context } = statusBarItems(snapshot)
  // A context at 73% colours the context item only.
  assert.deepEqual({ text: speed.text, tone: speed.tone, visible: speed.visible }, { text: '⚡ 82 tok/s', tone: 'neutral', visible: true })
  assert.equal(speed.tooltip, 'Agent Meter 出力速度（直近1時間）: Claude test-1 ≈82 tok/s / Codex gpt-test-1 ≈40 tok/s / pi local-test-1 120 tok/s')
  assert.deepEqual({ text: context.text, tone: context.tone, visible: context.visible }, { text: '◔ 73%', tone: 'warning', visible: true })
  // The fullest agents, fullest first.
  assert.equal(
    context.tooltip,
    'Agent Meter コンテキスト: alpha #2 73% / beta 18% / alpha #1 13% / develop #2 12% / develop Fix login flow 10% / develop codex: review 5%'
  )
})

test('status bar: tones at 70 and 90 percent, and the states with no figures', () => {
  const at = (tokens) =>
    statusBarItems(snapshotOf({ models: [], agents: [{ ...READER.agents[0], contextTokens: tokens }] }))
  assert.deepEqual(
    [at(138_000), at(140_000), at(179_000), at(180_000)].map((items) => items.context.tone),
    ['neutral', 'warning', 'warning', 'danger']
  )
  // However full the context, the speed item stays neutral.
  assert.deepEqual({ text: at(190_000).speed.text, tone: at(190_000).speed.tone }, { text: '⚡ —', tone: 'neutral' })
  assert.equal(at(190_000).context.text, '◔ 95%')

  // Nothing to show a percentage for: the context item is hidden, not shown empty.
  const empty = statusBarItems(snapshotOf({ models: [], agents: [] }))
  assert.deepEqual({ text: empty.speed.text, context: empty.context }, { text: '⚡ —', context: { visible: false } })

  // A failed read warns on the speed item; the context keeps the last good figure.
  const failed = statusBarItems(snapshotOf(READER, { error: { message: 'SSH で接続できません\n: x' } }))
  assert.deepEqual({ text: failed.speed.text, tone: failed.speed.tone }, { text: '⚡ 取得失敗', tone: 'warning' })
  assert.equal(/\n/.test(failed.speed.tooltip), false)
  assert.deepEqual({ text: failed.context.text, tone: failed.context.tone }, { text: '◔ 73%', tone: 'warning' })
  assert.match(failed.context.tooltip, /^Agent Meter コンテキスト（前回の値）: /)

  const unset = statusBarItems({ configured: false, groups: [] })
  assert.deepEqual({ text: unset.speed.text, context: unset.context }, { text: '⚡ 未設定', context: { visible: false } })

  const long = statusBarItems(
    snapshotOf({
      models: Array.from({ length: 30 }, (_, index) => ({ agent: 'pi', model: `local-test-model-${index}`, tokPerSec: 10, latest: 10, samples: 1, estimated: false })),
      agents: Array.from({ length: 12 }, (_, index) => ({ id: null, key: `k${index}`, agent: 'dsh', cwd: `/work/a-rather-long-workspace-name-${index}`, state: 'idle', model: 'm', contextTokens: 1000 * index, contextWindow: 20_000, windowEstimated: false }))
    })
  )
  for (const item of [long.speed, long.context]) {
    assert.ok(item.tooltip.length <= 256)
    assert.ok(item.text.length <= 64)
  }
})

test('consent: only the refusal for want of approval counts', () => {
  assert.equal(isConsentError({ code: 'consent_required', message: 'plugin is not enabled with current consent' }), true)
  assert.equal(isConsentError(new Error('plugin is not enabled with current consent')), true)
  assert.equal(isConsentError({ code: 'invalid_params', message: 'unknown status bar item' }), false)
  assert.equal(isConsentError(undefined), false)
})

test('change detection ignores the clock', () => {
  const first = snapshotOf(READER, { fetchedAt: 1 })
  const second = snapshotOf(READER, { fetchedAt: 2 })
  assert.equal(contentKey(first), contentKey(second))
  const moved = snapshotOf({ ...READER, models: [{ ...READER.models[0], tokPerSec: 41 }] }, { fetchedAt: 2 })
  assert.notEqual(contentKey(first), contentKey(moved))
  assert.notEqual(contentKey(first), contentKey({ ...first, consentRequired: true }))
})

// --- manifest ------------------------------------------------------------------------

test('manifest: settings match the worker defaults and hold no real host', () => {
  const settings = Object.fromEntries(manifest.contributes.settings.map((setting) => [setting.key, setting]))
  assert.deepEqual(Object.keys(settings).sort(), Object.keys(DEFAULTS).sort())
  for (const [key, value] of Object.entries(DEFAULTS)) assert.equal(settings[key].default, value, key)
  assert.equal(settings.sshTarget.placeholder, 'user@host')
  assert.deepEqual(settings.period.enum, ['15m', '1h', '24h'])
  assert.deepEqual(settings.displayMode.enum, ['statusbar', 'panel'])
  assert.equal(settings.refreshSeconds.minimum, 5)
  // The worker updates the items by these ids, and each is pressable.
  assert.deepEqual(manifest.contributes.statusBarItems.map((item) => item.id), STATUS_ITEMS)
  for (const item of manifest.contributes.statusBarItems) assert.equal(item.command, manifest.contributes.commands[0].id)
  assert.equal(manifest.contributes.panels[0].title, 'パフォーマンス')
})
