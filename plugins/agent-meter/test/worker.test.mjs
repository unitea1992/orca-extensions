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
  buildBootstrap,
  buildGroups,
  buildSshArgs,
  checkTarget,
  childEnv,
  contentKey,
  flattenAgents,
  parseReaderOutput,
  pickEnvironment,
  readerError,
  readerPayload,
  resolveSsh,
  statusBarItem,
  summarize,
  terminalHandles
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

test('ssh args: batch mode, optional identity, target after --', () => {
  const args = buildSshArgs({ sshTarget: ' user@host ', identityFile: '', remoteNode: '' })
  assert.deepEqual(args.slice(0, 7), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', 'user@host'])
  assert.equal(args.length, 8)
  assert.equal(args[7], buildBootstrap(''))
  const withKey = buildSshArgs({ sshTarget: 'user@host', identityFile: '/keys/id_test', remoteNode: '' })
  assert.deepEqual(withKey.slice(5, 9), ['-i', '/keys/id_test', '--', 'user@host'])
  assert.throws(() => buildSshArgs({ sshTarget: '-oProxyCommand=x' }), { code: 'invalid_params' })
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
  const posix = childEnv({}, 'linux')
  assert.ok(posix.HOME)
  assert.ok(posix.PATH)
  const windows = childEnv({}, 'win32')
  assert.ok(windows.USERPROFILE && windows.APPDATA && windows.LOCALAPPDATA && windows.SystemRoot)
  assert.equal(childEnv({ HOME: '/h', PATH: '/p' }, 'linux').PATH, '/p')
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
  const denied = readerError({ code: 255, stdout: '', stderr: 'user@host: Permission denied (publickey).\n' })
  assert.equal(denied.code, 'ssh_failed')
  assert.match(denied.message, /Permission denied/)
  const failed = readerError({ code: 0, stdout: `${SENTINEL}{"ok":false,"error":"boom"}\n`, stderr: '' })
  assert.match(failed.message, /boom/)
  assert.equal(readerError({ code: 1, stdout: '', stderr: 'SyntaxError: x\n' }).code, 'reader_failed')
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

test('worktree ps: known agent kinds with their workspace', () => {
  assert.deepEqual(
    flattenAgents(fixture('worktree-ps.json')).map(({ id, type, state, cwd, name }) => ({ id, type, state, cwd, name })),
    [
      { id: 'tab-1:leaf-1', type: 'claude', state: 'working', cwd: '/work/alpha', name: 'alpha' },
      { id: 'structured-agent-session-1:pane-1', type: 'codex', state: 'done', cwd: '/work/alpha', name: 'alpha' },
      { id: 'tab-2:leaf-2', type: 'pi', state: 'idle', cwd: '/work/beta', name: 'beta' }
    ]
  )
  assert.deepEqual(flattenAgents({}), [])
})

test('terminal list: pane key to handle, unsafe handles dropped', () => {
  const handles = terminalHandles(fixture('terminal-list.json'))
  assert.deepEqual([...handles], [['tab-1:leaf-1', 'term_one']])
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
    { id: null, agent: 'dsh', cwd: '/work/gamma', state: 'working', model: 'dsh-test-1', contextTokens: 9000, contextWindow: null, windowEstimated: false }
  ]
}

function snapshotOf(reader, overrides = {}) {
  const agents = flattenAgents(fixture('worktree-ps.json'))
  const handles = terminalHandles(fixture('terminal-list.json'))
  return {
    configured: true,
    label: 'user@host',
    period: '1h',
    refreshSeconds: 15,
    fetchedAt: 1,
    error: null,
    notice: null,
    groups: buildGroups(reader, agents, handles),
    ...overrides
  }
}

test('groups: per model, kinds in a fixed order, agents under their model', () => {
  const groups = snapshotOf(READER).groups
  assert.deepEqual(
    groups.map((group) => [group.agent, group.model, group.tokPerSec, group.rows.map((row) => row.name)]),
    [
      ['claude', 'claude-test-1', 82.4, ['alpha', 'beta']],
      ['claude', null, null, ['none']],
      ['codex', 'gpt-test-1', 40, ['alpha']],
      ['pi', 'local-test-1', 120, []],
      ['dsh', 'dsh-test-1', null, ['gamma']]
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
  // No window known: tokens only.
  assert.deepEqual({ tokens: groups[4].rows[0].tokens, percent: groups[4].rows[0].percent }, { tokens: 9000, percent: null })
})

test('status bar: median speed across models and the fullest context', () => {
  const snapshot = snapshotOf(READER)
  assert.deepEqual(summarize(snapshot.groups), { tokPerSec: 82.4, fullest: { percent: 73, name: 'alpha' } })
  const item = statusBarItem(snapshot)
  assert.equal(item.text, '⚡ 82 tok/s · ◔ 73%')
  assert.equal(item.tone, 'warning')
  assert.match(item.tooltip, /Claude test-1 ≈82 tok\/s \/ Codex gpt-test-1 ≈40 tok\/s \/ pi local-test-1 120 tok\/s \/ 最大 73% alpha/)
  assert.ok(item.tooltip.length <= 256)
})

test('status bar: tones at 70 and 90 percent, and the states with no figures', () => {
  const at = (tokens) =>
    statusBarItem(
      snapshotOf({ models: [], agents: [{ ...READER.agents[0], contextTokens: tokens }] })
    )
  assert.deepEqual([at(138_000).tone, at(140_000).tone, at(179_000).tone, at(180_000).tone], ['neutral', 'warning', 'warning', 'danger'])
  assert.equal(at(140_000).text, '⚡ — · ◔ 70%')
  assert.equal(statusBarItem(snapshotOf({ models: [], agents: [] })).text, '⚡ —')
  const failed = statusBarItem(snapshotOf(READER, { error: { message: 'SSH で接続できません\n: x' } }))
  assert.deepEqual({ text: failed.text, tone: failed.tone }, { text: '⚡ 取得失敗', tone: 'warning' })
  assert.equal(/\n/.test(failed.tooltip), false)
  const unset = statusBarItem({ configured: false, groups: [] })
  assert.equal(unset.text, '⚡ 未設定')
  const long = statusBarItem(
    snapshotOf({
      models: Array.from({ length: 30 }, (_, index) => ({ agent: 'pi', model: `local-test-model-${index}`, tokPerSec: 10, latest: 10, samples: 1, estimated: false })),
      agents: []
    })
  )
  assert.ok(long.tooltip.length <= 256)
  assert.ok(long.text.length <= 64)
})

test('change detection ignores the clock', () => {
  const first = snapshotOf(READER, { fetchedAt: 1 })
  const second = snapshotOf(READER, { fetchedAt: 2 })
  assert.equal(contentKey(first), contentKey(second))
  const moved = snapshotOf({ ...READER, models: [{ ...READER.models[0], tokPerSec: 41 }] }, { fetchedAt: 2 })
  assert.notEqual(contentKey(first), contentKey(moved))
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
  assert.equal(manifest.contributes.statusBarItems[0].id, 'meter')
  assert.equal(manifest.contributes.panels[0].title, 'パフォーマンス')
})
