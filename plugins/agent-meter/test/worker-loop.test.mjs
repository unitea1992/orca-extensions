// The worker as Orca runs it: against a stand-in Orca API, with stand-ins for `ssh`
// and the `orca` CLI on PATH. Covers when the server is read, what a failed read
// writes to the log, the connection test, and Orca refusing the settings for want of
// approval.
// A file of its own: it changes PATH and HOME for the whole process.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, test } from 'node:test'

import activate, { deactivate } from '../worker/main.mjs'

const posix = process.platform !== 'win32'
// The bootstrap takes the node path as a setting; it must be a plain path.
const plainNode = /^[A-Za-z0-9_.~/][A-Za-z0-9_.~/@+-]*$/.test(process.execPath)
const skip = !posix || !plainNode
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Counts the session, then runs the remote command as sshd would. AM_SSH_FAIL makes it
// end the way a broken client does: exit code 255 and not a word.
const SSH_STAND_IN = `#!/bin/sh
echo run >> "$AM_SSH_RUNS"
[ "$1" = -V ] && { echo OpenSSH_stand-in >&2; exit 0; }
[ -n "$AM_SSH_FAIL" ] && exit 255
for a; do last=$a; done
exec sh -c "$last"
`
const ORCA_STAND_IN = `#!/bin/sh
echo '{"ok":true,"result":{"worktrees":[],"terminals":[],"environments":[]}}'
`

const settings = {
  sshTarget: 'user@host',
  identityFile: '',
  remoteNode: process.execPath,
  environment: 'local',
  period: '1h',
  refreshSeconds: 5
}
const handlers = new Map()
const logs = []
/** Calls the worker made that a panel-only plugin has no business making. */
const unexpected = []
/** Set to make the stand-in host refuse like Orca does when approval is stale. */
let refuse = false
/** What the stand-in desktop answers to `workspace.list`, and the host calls it got. */
let workspaces = []
const hostCalls = []
const granted = ['settings:own', 'workspace:read', 'workspace:write']
let scratch = null
let counter = ''

const sshRuns = () => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0)
const ask = (force = false) => handlers.get('snapshot.get')({ force })

before(() => {
  if (skip) return
  scratch = mkdtempSync(join(tmpdir(), 'agent-meter-loop-'))
  const bin = join(scratch, 'bin')
  const home = join(scratch, 'home')
  counter = join(scratch, 'ssh-runs')
  mkdirSync(bin)
  mkdirSync(home)
  writeFileSync(join(bin, 'ssh'), SSH_STAND_IN)
  writeFileSync(join(bin, 'orca'), ORCA_STAND_IN)
  chmodSync(join(bin, 'ssh'), 0o755)
  chmodSync(join(bin, 'orca'), 0o755)
  process.env.PATH = `${bin}${delimiter}/usr/bin${delimiter}/bin`
  process.env.HOME = home
  process.env.AM_SSH_RUNS = counter
  delete process.env.AM_SSH_FAIL
  // The stand-in server must be empty: drop what would point the reader at real logs.
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'OPENCODE_DB', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    delete process.env[name]
  }
  activate({
    api: { major: 1, minor: 6 },
    grantedCapabilities: granted,
    log: (line) => logs.push(line),
    settings: {
      get: async (key) => {
        if (refuse) throw Object.assign(new Error('plugin is not enabled with current consent'), { code: 'consent_required' })
        return settings[key]
      },
      onDidChange: () => unexpected.push('settings.onDidChange')
    },
    panels: { handle: (name, handler) => handlers.set(name, handler), post: (name) => unexpected.push(`panels.post ${name}`) },
    host: {
      has: () => true,
      call: async (method, params) => {
        if (refuse) throw Object.assign(new Error('plugin is not enabled with current consent'), { code: 'consent_required' })
        hostCalls.push([method, params])
        if (method === 'workspace.list') return { workspaces, truncated: false }
        if (method === 'workspace.open') return { opened: true }
        throw Object.assign(new Error(`no such method ${method}`), { code: 'unknown_method' })
      }
    }
  })
})

after(() => {
  deactivate()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

test('the server is read when a panel asks, and at no other time', { skip, timeout: 60_000 }, async () => {
  // No panel has asked: nothing is read and nothing is scheduled.
  await sleep(600)
  assert.equal(sshRuns(), 0)

  // A panel asks: one read, answered with the result.
  const first = await ask()
  assert.deepEqual(
    { configured: first.configured, error: first.error, refreshSeconds: first.refreshSeconds, consentRequired: first.consentRequired },
    { configured: true, error: null, refreshSeconds: 5, consentRequired: false }
  )
  assert.equal(sshRuns(), 1)

  // A second panel asking right after shares the answer instead of reading again.
  const second = await ask()
  assert.equal(second.fetchedAt, first.fetchedAt)
  assert.equal(sshRuns(), 1)

  // Two asks at once are one read; a changed setting reads again whatever the age.
  const [left, right] = await Promise.all([ask(true), ask()])
  assert.equal(left.fetchedAt >= first.fetchedAt && right.fetchedAt >= first.fetchedAt, true)
  const afterForce = sshRuns()
  assert.ok(afterForce === 2 || afterForce === 3)

  // The panel is closed: it stops asking. Well past the refresh interval nothing was
  // read, and the worker made no host call or post on its own.
  await sleep(settings.refreshSeconds * 1000 + 1000)
  assert.equal(sshRuns(), afterForce)
  assert.deepEqual(unexpected, [])
  assert.deepEqual(hostCalls, [])

  // It opens again: the answer is older than half an interval, so this ask reads.
  const reopened = await ask()
  assert.ok(reopened.fetchedAt > first.fetchedAt)
  assert.equal(sshRuns(), afterForce + 1)
})

test('connection test: every step runs the real ssh arguments', { skip, timeout: 60_000 }, async () => {
  logs.length = 0
  const report = await handlers.get('connection.test')({})
  assert.equal(report.ok, true)
  assert.equal(report.version, 'OpenSSH_stand-in')
  assert.match(report.ssh, /ssh$/)
  assert.deepEqual(
    report.steps.map((step) => [step.name, step.ok]),
    [
      ['接続', true],
      ['標準入力', true],
      ['node の検出', true],
      ['読み取り', true]
    ]
  )
  // Each step is in the log with what was run.
  assert.ok(logs.some((line) => line.startsWith('test 接続 args: ') && line.includes('"user@host","echo AGENT_METER_ECHO"')))
  assert.ok(logs.some((line) => line.startsWith('test 標準入力 stdin: 18 bytes')))
})

test('a silent ssh failure is reported with its exit code and logged in full', { skip, timeout: 60_000 }, async () => {
  const good = await ask(true)
  process.env.AM_SSH_FAIL = '1'
  try {
    logs.length = 0
    const failed = await ask(true)
    assert.equal(failed.error.message, 'SSH で接続できません（終了コード 255、ssh からのメッセージなし）')
    // The time of the last good read is kept, so the panel can say the figures are old.
    assert.equal(failed.fetchedAt, good.fetchedAt)
    // The log names the binary, the arguments as passed, and that nothing was printed.
    assert.ok(logs.some((line) => line.startsWith('state ERR ssh_failed')))
    assert.ok(logs.some((line) => /^ssh: 終了コード 255 \d+ms ssh=.*ssh$/.test(line)))
    assert.ok(logs.some((line) => line.startsWith('ssh args: ["-T","-o","BatchMode=yes","-o","ConnectTimeout=10","user@host","sh -c ')))
    assert.ok(logs.some((line) => line === 'ssh stderr: (空)'))
    assert.ok(logs.some((line) => line.startsWith('ssh env: 補った変数=[')))

    // The same failure on the next reads is not written again.
    await ask(true)
    await ask(true)
    assert.equal(logs.filter((line) => line.startsWith('ssh args: ')).length, 1)
    assert.equal(logs.filter((line) => line.startsWith('state ERR')).length, 1)

    // The test stops at the first step, and runs it again with -v for the trace.
    logs.length = 0
    const report = await handlers.get('connection.test')({})
    assert.equal(report.ok, false)
    assert.deepEqual(
      report.steps.map((step) => [step.name, step.ok, step.detail]),
      [['接続', false, '終了コード 255、メッセージなし']]
    )
    assert.deepEqual(report.steps[0].trace, [])
    assert.ok(logs.some((line) => line.startsWith('test 接続 (-v) args: ["-v","-T",')))
  } finally {
    delete process.env.AM_SSH_FAIL
  }
  assert.equal((await ask(true)).error, null)
})

test('stale approval: logged once, shown in the panel, and cleared when it comes back', { skip, timeout: 60_000 }, async () => {
  assert.equal((await ask(true)).consentRequired, false)
  logs.length = 0
  refuse = true
  try {
    const refused = await ask(true)
    // The panel is told, and the settings last read still apply: the target is not
    // suddenly "not set".
    assert.deepEqual(
      { consentRequired: refused.consentRequired, configured: refused.configured, error: refused.error },
      { consentRequired: true, configured: true, error: null }
    )
    await ask(true)
    await ask(true)
    assert.equal(logs.filter((line) => line.startsWith('consent_required:')).length, 1)
  } finally {
    refuse = false
  }
  // Approved again: the next read says so once, and the banner goes.
  assert.equal((await ask(true)).consentRequired, false)
  await ask(true)
  assert.equal(logs.filter((line) => line.startsWith('consent: ')).length, 1)
})

test('pressing a row opens its workspace on this desktop', { skip, timeout: 60_000 }, async () => {
  const open = (row) => handlers.get('row.open')(row)
  workspaces = [
    { id: 'ws-local', kind: 'worktree', name: 'alpha', path: '/work/alpha', branch: 'main', hostId: null },
    { id: 'ws-remote', kind: 'worktree', name: 'alpha', path: '/work/alpha', branch: 'main', hostId: 'env-1' },
    { id: 'repo-2::/work/beta', kind: 'worktree', name: 'beta', path: '/work/beta', branch: null, hostId: 'env-1' }
  ]
  // A chat-view agent has no terminal; its workspace is what opens. The same path exists
  // here and on the server: the server's is the one.
  hostCalls.length = 0
  assert.deepEqual(await open({ id: 'structured-agent-session-1:pane-1', worktreeId: 'repo-1::/work/alpha', path: '/work/alpha' }), { ok: true })
  assert.deepEqual(hostCalls, [
    ['workspace.list', {}],
    ['workspace.open', { workspaceId: 'ws-remote' }]
  ])
  // The server's worktree id, when this desktop knows it, settles it without the path.
  hostCalls.length = 0
  await open({ id: 'x', worktreeId: 'repo-2::/work/beta', path: '/somewhere/else' })
  assert.deepEqual(hostCalls.at(-1), ['workspace.open', { workspaceId: 'repo-2::/work/beta' }])
  // A session Orca does not list has only its directory.
  hostCalls.length = 0
  await open({ id: null, worktreeId: '', path: '/work/beta' })
  assert.deepEqual(hostCalls.at(-1), ['workspace.open', { workspaceId: 'repo-2::/work/beta' }])

  // Nothing to open: said, not swallowed.
  await assert.rejects(open({ id: 'x', worktreeId: '', path: '/work/none' }), /none のワークスペースが見つかりません/)
  refuse = true
  try {
    await assert.rejects(open({ id: 'x', worktreeId: '', path: '/work/beta' }), /承認をやり直してください/)
  } finally {
    refuse = false
  }
  // Loaded under an approval that predates the workspace access: no call is attempted.
  granted.length = 1
  try {
    hostCalls.length = 0
    await assert.rejects(open({ id: 'x', worktreeId: '', path: '/work/beta' }), /権限がありません/)
    assert.deepEqual(hostCalls, [])
  } finally {
    granted.push('workspace:read', 'workspace:write')
  }
})
