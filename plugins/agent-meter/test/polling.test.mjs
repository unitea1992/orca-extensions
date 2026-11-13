// When the worker reads the server. Runs the real worker against a stand-in Orca API,
// with stand-ins for `ssh` and the `orca` CLI on PATH, and counts SSH sessions.
// A file of its own: it changes PATH and HOME for the whole process.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, test } from 'node:test'

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let scratch = null
after(() => {
  deactivate()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

test('panel-only mode reads only while a panel is open', { skip: !posix || !plainNode, timeout: 60_000 }, async () => {
  scratch = mkdtempSync(join(tmpdir(), 'agent-meter-poll-'))
  const bin = join(scratch, 'bin')
  const home = join(scratch, 'home')
  const counter = join(scratch, 'ssh-runs')
  mkdirSync(bin)
  mkdirSync(home)
  // Counts the session, then runs the remote command as sshd would.
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\necho run >> "$AM_SSH_RUNS"\nfor a; do last=$a; done\nexec sh -c "$last"\n')
  writeFileSync(join(bin, 'orca'), '#!/bin/sh\necho \'{"ok":true,"result":{"worktrees":[],"terminals":[],"environments":[]}}\'\n')
  chmodSync(join(bin, 'ssh'), 0o755)
  chmodSync(join(bin, 'orca'), 0o755)
  process.env.PATH = `${bin}${delimiter}/usr/bin${delimiter}/bin`
  process.env.HOME = home
  process.env.AM_SSH_RUNS = counter
  const sshRuns = () => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0)
  const until = async (check, what) => {
    for (let waited = 0; waited < 10_000; waited += 50) {
      if (check()) return
      await sleep(50)
    }
    assert.fail(`timed out waiting for ${what}`)
  }

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
  const bars = []
  const posts = []
  let changed = () => {}
  const orca = {
    api: { major: 1, minor: 6 },
    grantedCapabilities: ['settings:own'],
    log() {},
    settings: { get: async (key) => settings[key], onDidChange: (handler) => (changed = handler) },
    panels: { handle: (name, handler) => handlers.set(name, handler), post: (name) => posts.push(name) },
    host: { has: () => true, call: async (method, params) => (bars.push(params), { ok: true }) }
  }

  activate(orca)

  // No panel has asked: the status bar item is hidden and the server is left alone.
  await until(() => bars.length > 0, 'the status bar update')
  await sleep(600)
  assert.equal(bars.at(-1).visible, false)
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
  assert.equal(bars.at(-1).visible, false)

  // With the status bar item shown, the worker reads with no panel at all.
  await handlers.get('panel.hidden')({})
  const beforeSwitch = sshRuns()
  settings.displayMode = 'statusbar'
  changed({ key: 'displayMode' })
  await until(() => bars.at(-1).visible === true, 'the status bar item to show')
  await until(() => sshRuns() > beforeSwitch, 'a read in status bar mode')
  assert.ok(posts.includes('snapshot'))
})
