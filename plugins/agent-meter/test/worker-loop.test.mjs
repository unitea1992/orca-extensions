// The worker as Orca runs it: against a stand-in Orca API, with stand-ins for `ssh`
// and the `orca` CLI on PATH. Covers when the server is read, what a failed read
// writes to the log, the connection test, and Orca refusing calls for want of approval.
// A file of its own: it changes PATH and HOME for the whole process.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, test } from 'node:test'

import activate, { PANEL_ALIVE_MS, deactivate, shouldPoll } from '../worker/main.mjs'

test('shouldPoll: the status bar always, a panel only while it is open', () => {
  const now = 1_000_000
  assert.equal(shouldPoll('statusbar', 0, now), true)
  assert.equal(shouldPoll('panel', 0, now), false)
  assert.equal(shouldPoll('panel', now - 1000, now), true)
  // A visible panel beats every 20 s; two missed beats mean it is closed.
  assert.equal(shouldPoll('panel', now - PANEL_ALIVE_MS + 1, now), true)
  assert.equal(shouldPoll('panel', now - PANEL_ALIVE_MS, now), false)
})

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
  displayMode: 'panel',
  sshTarget: 'user@host',
  identityFile: '',
  remoteNode: process.execPath,
  environment: 'local',
  period: '1h',
  refreshSeconds: 5
}
const handlers = new Map()
/** Every status bar update the worker sent, and the latest per item. */
const bars = []
const bar = (id) => bars.findLast((update) => update.id === id) ?? {}
const posts = []
const logs = []
/** Set to make the stand-in host refuse like Orca does when approval is stale. */
let refuse = false
let changed = () => {}
let scratch = null
let counter = ''

const sshRuns = () => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0)

async function until(check, what) {
  for (let waited = 0; waited < 10_000; waited += 50) {
    if (check()) return
    await sleep(50)
  }
  assert.fail(`timed out waiting for ${what}`)
}

before(() => {
  if (skip) return
  scratch = mkdtempSync(join(tmpdir(), 'agent-meter-poll-'))
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
    grantedCapabilities: ['settings:own'],
    log: (line) => logs.push(line),
    settings: { get: async (key) => settings[key], onDidChange: (handler) => (changed = handler) },
    panels: { handle: (name, handler) => handlers.set(name, handler), post: (name) => posts.push(name) },
    host: {
      has: () => true,
      call: async (method, params) => {
        if (refuse) throw Object.assign(new Error('plugin is not enabled with current consent'), { code: 'consent_required' })
        bars.push(params)
        return { ok: true }
      }
    }
  })
})

after(() => {
  deactivate()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

test('panel-only mode reads only while a panel is open', { skip, timeout: 60_000 }, async () => {
  // No panel has asked: the status bar item is hidden and the server is left alone.
  await until(() => bars.length >= 2, 'the status bar updates')
  await sleep(600)
  assert.deepEqual([bar('speed').visible, bar('context').visible], [false, false])
  assert.equal(sshRuns(), 0)

  // A panel opens: one read, answered with the result.
  const opened = await handlers.get('snapshot.get')({})
  assert.deepEqual({ configured: opened.configured, error: opened.error }, { configured: true, error: null })
  assert.equal(sshRuns(), 1)

  // While it stays open the worker keeps reading on its own timer.
  await until(() => sshRuns() === 2, 'the next timed read')

  // It closes: the timer that was pending finds nobody watching and stops.
  // Waiting past one interval covers that timer; had it read, or re-armed, the count
  // would have moved.
  await handlers.get('panel.hidden')({})
  await sleep(settings.refreshSeconds * 1000 + 1500)
  const atClose = sshRuns()
  assert.equal(atClose, 2)

  // It opens again: what is known comes back at once and a fresh read follows.
  const reopened = await handlers.get('snapshot.get')({})
  assert.equal(reopened.configured, true)
  await until(() => sshRuns() === atClose + 1, 'the read after reopening')
  assert.deepEqual([bar('speed').visible, bar('context').visible], [false, false])

  // With the status bar item shown, the worker reads with no panel at all.
  await handlers.get('panel.hidden')({})
  const beforeSwitch = sshRuns()
  settings.displayMode = 'statusbar'
  changed({ key: 'displayMode' })
  await until(() => bar('speed').visible === true, 'the speed item to show')
  await until(() => sshRuns() > beforeSwitch, 'a read in status bar mode')
  assert.ok(posts.includes('snapshot'))
  // Nothing on the stand-in server, so there is a speed item and no percentage to show.
  assert.deepEqual({ text: bar('speed').text, tone: bar('speed').tone }, { text: '⚡ —', tone: 'neutral' })
  assert.equal(bar('context').visible, false)
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
  process.env.AM_SSH_FAIL = '1'
  try {
    logs.length = 0
    settings.period = '15m'
    changed({ key: 'period' })
    await until(() => logs.some((line) => line.startsWith('state ERR ssh_failed')), 'the failed read')
    const snapshot = await handlers.get('snapshot.get')({})
    assert.equal(snapshot.error.message, 'SSH で接続できません（終了コード 255、ssh からのメッセージなし）')
    await until(() => bar('speed').text === '⚡ 取得失敗', 'the failure on the speed item')
    assert.equal(bar('speed').tone, 'warning')
    // The log names the binary, the arguments as passed, and that nothing was printed.
    assert.ok(logs.some((line) => /^ssh: 終了コード 255 \d+ms ssh=.*ssh$/.test(line)))
    assert.ok(logs.some((line) => line.startsWith('ssh args: ["-T","-o","BatchMode=yes","-o","ConnectTimeout=10","user@host","sh -c ')))
    assert.ok(logs.some((line) => line === 'ssh stderr: (空)'))
    assert.ok(logs.some((line) => line.startsWith('ssh env: 補った変数=[')))

    // The same failure on the next reads is not written again.
    const runsBefore = sshRuns()
    await until(() => sshRuns() >= runsBefore + 1, 'another failed read')
    await sleep(300)
    assert.equal(logs.filter((line) => line.startsWith('ssh args: ')).length, 1)

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
})

test('stale approval: logged once, shown in the panel, and cleared when it comes back', { skip, timeout: 60_000 }, async () => {
  const snapshot = async () => handlers.get('snapshot.get')({})
  // Each settings change makes the worker read and publish again, as a refresh does.
  const refreshOnce = async () => {
    const before = sshRuns()
    settings.period = settings.period === '1h' ? '24h' : '1h'
    changed({ key: 'period' })
    await until(() => sshRuns() > before, 'a read')
    await sleep(300)
  }
  await refreshOnce()
  assert.equal((await snapshot()).consentRequired, false)

  logs.length = 0
  posts.length = 0
  refuse = true
  try {
    await refreshOnce()
    await until(() => logs.some((line) => line.startsWith('consent_required:')), 'the consent line')
    // The panel is told, by a post and in the answer to its own request.
    assert.equal((await snapshot()).consentRequired, true)
    assert.ok(posts.includes('snapshot'))

    // Both items are refused on every refresh; the log still has the one line.
    await refreshOnce()
    await refreshOnce()
    assert.equal(logs.filter((line) => line.startsWith('consent_required:')).length, 1)
    assert.equal(logs.some((line) => line.includes('statusBar.update ERR')), false)
    assert.equal((await snapshot()).consentRequired, true)
  } finally {
    refuse = false
  }

  // Approved again: the next refresh goes through, says so once, and the banner goes.
  const sent = bars.length
  await refreshOnce()
  await until(() => logs.some((line) => line.startsWith('consent: ')), 'the recovery line')
  assert.equal((await snapshot()).consentRequired, false)
  assert.ok(bars.length > sent)
  assert.equal(logs.filter((line) => line.startsWith('consent: ')).length, 1)
})
