import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import {
  MIN_MS,
  MIN_TOKENS,
  aggregate,
  claudeProjectDir,
  collect,
  dshStreamEnd,
  dshTokens,
  eligible,
  jsonLines,
  median,
  opencodeMessage,
  opencodeWindows,
  parseClaude,
  parseCodex,
  parseCodexHead,
  parseDsh,
  parseJsonc,
  parsePi,
  piSessionDir,
  piWindows,
  readHead,
  readTail
} from '../reader/reader.mjs'

/** The instant every fixture is timed from (scripts/make-fixtures.mjs). */
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0)

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name) => readFileSync(join(fixtures, name), 'utf8')
const rate = (entry) => (entry.tokens * 1000) / entry.ms
const hasSqlite = await import('node:sqlite').then(
  () => true,
  () => false
)
const hasZstd = typeof zlib.zstdCompressSync === 'function'

// --- helpers -----------------------------------------------------------------

test('jsonLines skips what is not a whole record', () => {
  const records = [...jsonLines('{"a":1}\nnot json\n[1,2]\n\n{"b":2}\n{"cut":')]
  assert.deepEqual(records, [{ a: 1 }, { b: 2 }])
})

test('median', () => {
  assert.equal(median([]), null)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
})

test('readTail drops the partial first line of a cut file; readHead the partial last', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-meter-'))
  try {
    const file = join(dir, 'log.jsonl')
    writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":3}\n')
    assert.deepEqual(readTail(file, 1024), { text: '{"n":1}\n{"n":2}\n{"n":3}\n', truncated: false })
    assert.deepEqual(readTail(file, 12), { text: '{"n":3}\n', truncated: true })
    assert.equal(readHead(file, 12), '{"n":1}\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseJsonc reads comments and trailing commas', () => {
  assert.deepEqual(parseJsonc('{ "a": "// not a comment", /* x */ "b": [1, 2,], }'), {
    a: '// not a comment',
    b: [1, 2]
  })
  assert.equal(parseJsonc('{ nope'), null)
})

test('aggregate applies the noise floor and the period', () => {
  const now = T0 + 60_000
  const since = now - 15 * 60_000
  const entry = (tokens, ms, at, model = 'm', estimated = false) => ({ agent: 'pi', model, tokens, ms, at, estimated })
  assert.equal(eligible(entry(MIN_TOKENS - 1, 5000, T0), since, now), false)
  assert.equal(eligible(entry(500, MIN_MS - 1, T0), since, now), false)
  assert.equal(eligible(entry(500, 5000, since - 1), since, now), false)
  const models = aggregate(
    [
      entry(100, 1000, T0),
      entry(300, 1000, T0 + 2000),
      entry(200, 1000, T0 + 1000),
      entry(10, 1000, T0 + 3000),
      entry(400, 2000, T0, 'other', true)
    ],
    since,
    now
  )
  assert.deepEqual(models, [
    { agent: 'pi', model: 'm', tokPerSec: 200, latest: 300, lastAt: T0 + 2000, samples: 3, estimated: false },
    { agent: 'pi', model: 'other', tokPerSec: 200, latest: 200, lastAt: T0, samples: 1, estimated: true }
  ])
})

// --- Claude Code ---------------------------------------------------------------

test('claude: project folder name', () => {
  assert.equal(claudeProjectDir('/work/my.repo_x/a-b'), '-work-my-repo-x-a-b')
})

test('claude: blocks collapse by message id, start from api-request or parent', () => {
  const { samples, context, peaks } = parseClaude(fixture('claude/main.jsonl'))
  assert.equal(samples.length, 4)
  const [first, second, side, short] = samples
  // msg_1: two blocks, the larger output_tokens, from the api-request record to the last block.
  assert.deepEqual(
    { tokens: first.tokens, ms: first.ms, at: first.at, model: first.model, estimated: first.estimated },
    { tokens: 400, ms: 4000, at: T0 + 4200, model: 'claude-test-1', estimated: true }
  )
  // msg_2: no requestRef, so from its parent, skipping the attachment.
  assert.deepEqual({ tokens: second.tokens, ms: second.ms }, { tokens: 150, ms: 3000 })
  assert.equal(rate(side), 200)
  assert.equal(eligible(short, T0 - 1000, T0 + 60_000), false)
  // The sidechain's 500k and the synthetic message are not the session's context.
  assert.deepEqual(context, {
    tokens: 61_515,
    model: 'claude-test-1',
    at: T0 + 12_000,
    window: 200_000,
    windowEstimated: true
  })
  assert.equal(peaks.get('claude-test-1'), 62_012)
})

test('claude: a message whose start fell outside the tail is not guessed', () => {
  const lines = fixture('claude/main.jsonl').split('\n')
  const cut = lines.slice(lines.findIndex((line) => line.includes('"uuid":"a2"'))).join('\n')
  const { samples } = parseClaude(cut)
  // msg_1 lost its api-request record and its first block's parent.
  assert.equal(samples.some((entry) => entry.tokens === 400), false)
  assert.equal(samples.some((entry) => entry.tokens === 150), true)
})

test('claude: a request past 200k means the wide window', () => {
  const { context, samples } = parseClaude(fixture('claude/wide.jsonl'))
  assert.equal(context.tokens, 250_000)
  assert.equal(context.window, 1_000_000)
  assert.equal(rate(samples[0]), 100)
  const suffixed = parseClaude(fixture('claude/wide.jsonl').replaceAll('claude-test-1', 'claude-test-1[1m]'))
  assert.equal(suffixed.context.window, 1_000_000)
})

// --- Codex -----------------------------------------------------------------------

test('codex: head gives cwd, subagent flag and first model', () => {
  assert.deepEqual(parseCodexHead(fixture('codex/rollout-new.jsonl')), {
    cwd: '/work/alpha',
    subagent: false,
    model: 'gpt-test-1'
  })
  assert.equal(parseCodexHead(fixture('codex/rollout-subagent.jsonl')).subagent, true)
  assert.equal(parseCodexHead(fixture('codex/rollout-old.jsonl')).subagent, false)
})

test('codex: a response is timed without the tool run that follows it', () => {
  const { samples, context } = parseCodex(fixture('codex/rollout-new.jsonl'))
  assert.equal(samples.length, 2)
  // 410 output tokens (reasoning included) from task start to the usage record: the
  // 30 s tool run is outside. The repeated token_count adds nothing.
  assert.deepEqual(
    samples.map((entry) => ({ tokens: entry.tokens, ms: entry.ms, model: entry.model })),
    [
      { tokens: 410, ms: 4100, model: 'gpt-test-1' },
      { tokens: 150, ms: 3000, model: 'gpt-test-1' }
    ]
  )
  assert.deepEqual(context, {
    tokens: 100_800,
    model: 'gpt-test-1',
    at: T0 + 38_020,
    window: 400_000,
    windowEstimated: false
  })
})

test('codex: without token_usage_record the last output item ends the response', () => {
  const { samples, context } = parseCodex(fixture('codex/rollout-old.jsonl'))
  // Reasoning is reported apart here, so it is added: 200 + 50. The second response
  // starts at its tool's output, not at the token_count 8 s before it.
  assert.deepEqual(
    samples.map((entry) => ({ tokens: entry.tokens, ms: entry.ms })),
    [
      { tokens: 250, ms: 2000 },
      { tokens: 100, ms: 2000 }
    ]
  )
  assert.deepEqual({ tokens: context.tokens, window: context.window }, { tokens: 5200, window: 200_000 })
})

test('codex: a cut rollout takes its model from the head', () => {
  const lines = fixture('codex/rollout-new.jsonl').split('\n')
  const tail = lines.slice(2).join('\n')
  assert.equal(parseCodex(tail).samples[0].model, 'unknown')
  assert.equal(parseCodex(tail, { model: 'gpt-test-1' }).samples[0].model, 'gpt-test-1')
})

// --- pi --------------------------------------------------------------------------

test('pi: session folder name', () => {
  assert.equal(piSessionDir('/work/alpha.x'), '--work-alpha.x--')
  assert.equal(piSessionDir('C:\\work\\alpha'), '--C--work-alpha--')
})

test('pi: durationMs and output, reasoning not added twice', () => {
  const windows = piWindows(JSON.parse(fixture('pi/models.json')))
  const { samples, context, cwd } = parsePi(fixture('pi/session.jsonl'), windows)
  assert.equal(cwd, '/work/alpha')
  assert.deepEqual(
    samples.map((entry) => ({ tokens: entry.tokens, ms: entry.ms, estimated: entry.estimated })),
    [
      { tokens: 200, ms: 4000, estimated: false },
      { tokens: 300, ms: 2000, estimated: false },
      { tokens: 0, ms: 100, estimated: false }
    ]
  )
  // The failed message has no usage, so the one before it is the context.
  assert.deepEqual(context, {
    tokens: 31_000,
    model: 'local-test-1',
    at: T0 + 14_000,
    window: 100_000,
    windowEstimated: false
  })
  assert.equal(parsePi(fixture('pi/session.jsonl')).context.window, null)
})

// --- OpenCode ------------------------------------------------------------------------

test('opencode: output plus reasoning over created to streamed', () => {
  const { messages } = JSON.parse(fixture('opencode/rows.json'))
  const windows = opencodeWindows(parseJsonc(fixture('opencode/opencode.json')))
  assert.equal(windows.get('ocprov/oc-test-1'), 200_000)
  const row = (message) => ({
    tokens: JSON.stringify(message.data.tokens),
    time: JSON.stringify(message.data.time),
    model: JSON.stringify(message.data.model)
  })
  const first = opencodeMessage(row(messages[1]), windows)
  assert.deepEqual(
    { tokens: first.sample.tokens, ms: first.sample.ms, model: first.sample.model },
    { tokens: 200, ms: 4000, model: 'oc-test-1' }
  )
  assert.deepEqual(first.context, {
    tokens: 20_500,
    model: 'oc-test-1',
    at: T0 + 6000,
    window: 200_000,
    windowEstimated: false
  })
  const streaming = opencodeMessage(row(messages[3]), windows)
  assert.deepEqual(streaming, { sample: null, context: null })
})

// --- DSH ---------------------------------------------------------------------------

test('dsh: token fields and compact stream records', () => {
  assert.deepEqual(dshTokens({ input: 1, output: 2, reasoning: 3 }), { input: 1, output: 2, think: 3, cacheRead: 0, cacheWrite: 0 })
  assert.equal(dshTokens({}), null)
  assert.equal(dshStreamEnd([{ type: 'text-chunks', time0: 100, dt: [10, 20], texts: ['a', 'b', 'c'] }]), 130)
  assert.equal(dshStreamEnd([{ type: 'chunk', time: 50, chunk: {} }, { type: 'chunk', time: 40, chunk: {} }]), 50)
  assert.equal(dshStreamEnd([]), null)
})

test('dsh: request/context to the end of the stream, think added to output', () => {
  const { header, samples, context, model, window } = parseDsh(fixture('dsh/session.jsonl'))
  assert.deepEqual(header, { cwd: '/work/gamma', subagent: false })
  assert.deepEqual(
    samples.map((entry) => ({ tokens: entry.tokens, ms: entry.ms, at: entry.at, model: entry.model })),
    [
      { tokens: 400, ms: 4000, at: T0 + 4100, model: 'dsh-test-1' },
      { tokens: 200, ms: 2000, at: T0 + 12_100, model: 'dsh-test-1' }
    ]
  )
  assert.deepEqual(context, {
    tokens: 43_000,
    model: 'dsh-test-1',
    at: T0 + 12_100,
    window: 128_000,
    windowEstimated: false
  })
  assert.deepEqual({ model, window }, { model: 'dsh-test-1', window: 128_000 })
})

// --- the whole run, against a home directory built from the fixtures ---------------

function place(home, relative, source, at) {
  const target = join(home, relative)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(fixtures, source), target)
  utimesSync(target, at / 1000, at / 1000)
  return target
}

async function buildHome() {
  const home = mkdtempSync(join(tmpdir(), 'agent-meter-home-'))
  const at = T0 + 60_000
  place(home, '.claude/projects/-work-alpha/sess-main.jsonl', 'claude/main.jsonl', at)
  place(home, '.claude/projects/-work-alpha/sess-main/subagents/agent-x.jsonl', 'claude/subagent.jsonl', at)
  place(home, '.claude/projects/-work-beta/sess-wide.jsonl', 'claude/wide.jsonl', at)
  if (process.platform !== 'win32') {
    // An Orca profile whose projects folder is the shared one: must not count twice.
    mkdirSync(join(home, '.config/orca/claude-profiles/p1/home'), { recursive: true })
    symlinkSync(join(home, '.claude/projects'), join(home, '.config/orca/claude-profiles/p1/home/projects'))
  }
  place(home, '.codex/sessions/2026/01/15/rollout-fixture-new.jsonl', 'codex/rollout-new.jsonl', at)
  place(home, '.config/orca/codex-accounts/acc/home/sessions/2026/01/15/rollout-fixture-old.jsonl', 'codex/rollout-old.jsonl', T0 + 700_000)
  // Newer than the user's own thread in the same directory.
  place(home, '.config/orca/codex-accounts/acc/home/sessions/2026/01/15/rollout-fixture-sub.jsonl', 'codex/rollout-subagent.jsonl', at + 5000)
  place(home, '.pi/agent/sessions/--work-alpha--/session.jsonl', 'pi/session.jsonl', at)
  place(home, '.pi/agent/models.json', 'pi/models.json', at)
  place(home, '.config/opencode/opencode.json', 'opencode/opencode.json', at)
  if (hasSqlite) {
    const { DatabaseSync } = await import('node:sqlite')
    const rows = JSON.parse(fixture('opencode/rows.json'))
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true })
    const db = new DatabaseSync(join(home, '.local/share/opencode/opencode.db'))
    db.exec(
      'CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, time_updated INTEGER);' +
        'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);'
    )
    const session = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?)')
    for (const row of rows.sessions) session.run(row.id, row.directory, row.parent_id, row.time_updated)
    const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)')
    rows.messages.forEach((row, index) =>
      message.run(`msg_${index}`, row.session_id, row.type, row.seq, row.time_created, JSON.stringify(row.data))
    )
    db.close()
  }
  if (hasZstd) {
    const target = join(home, '.dsh/sessions/-work-gamma/session-fixture/session.v4.jsonl.zstd')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, zlib.zstdCompressSync(Buffer.from(fixture('dsh/session.jsonl'))))
    utimesSync(target, at / 1000, at / 1000)
  }
  return home
}

const AGENTS = [
  { id: 'c-alpha', type: 'claude', cwd: '/work/alpha', state: 'working', updatedAt: 3 },
  { id: 'c-beta', type: 'claude', cwd: '/work/beta', state: 'done', updatedAt: 2 },
  { id: 'c-none', type: 'claude', cwd: '/work/none', state: 'done', updatedAt: 1 },
  { id: 'x-alpha', type: 'codex', cwd: '/work/alpha', state: 'working', updatedAt: 1 },
  { id: 'p-alpha', type: 'pi', cwd: '/work/alpha', state: 'idle', updatedAt: 1 },
  { id: 'o-alpha', type: 'opencode', cwd: '/work/alpha', state: 'working', updatedAt: 1 },
  { id: 'ignored', type: 'someone-else', cwd: '/work/alpha', state: 'working', updatedAt: 1 }
]

test('collect: speeds per model and a context per live agent', async () => {
  const home = await buildHome()
  try {
    const now = T0 + 12 * 60_000
    const result = await collect({ period: '15m', agents: AGENTS }, { home, env: {}, now })
    assert.equal(result.ok, true)
    assert.equal(result.truncated, false)
    assert.equal(result.period, '15m')

    const speed = Object.fromEntries(result.models.map((model) => [`${model.agent}/${model.model}`, model]))
    // main: 100, 50, 200; wide: 100. Read once although two roots lead to the folder.
    assert.deepEqual(
      { tokPerSec: speed['claude/claude-test-1'].tokPerSec, samples: speed['claude/claude-test-1'].samples, estimated: speed['claude/claude-test-1'].estimated },
      { tokPerSec: 100, samples: 4, estimated: true }
    )
    assert.equal(speed['claude/claude-test-mini'].tokPerSec, 150)
    assert.deepEqual(
      { tokPerSec: speed['codex/gpt-test-1'].tokPerSec, latest: speed['codex/gpt-test-1'].latest, samples: speed['codex/gpt-test-1'].samples },
      { tokPerSec: 75, latest: 50, samples: 2 }
    )
    assert.equal(speed['codex/gpt-test-review'].tokPerSec, 100)
    // The rollout without token_usage_record, from the Orca account folder.
    assert.equal(speed['codex/gpt-test-2'].tokPerSec, 87.5)
    assert.deepEqual(
      { tokPerSec: speed['pi/local-test-1'].tokPerSec, samples: speed['pi/local-test-1'].samples, estimated: speed['pi/local-test-1'].estimated },
      { tokPerSec: 100, samples: 2, estimated: false }
    )

    const agents = Object.fromEntries(result.agents.map((row) => [row.id ?? `dsh:${row.cwd}`, row]))
    // 61,515 of a window that another session of the same model proved to be 1M.
    assert.deepEqual(
      { model: agents['c-alpha'].model, tokens: agents['c-alpha'].contextTokens, window: agents['c-alpha'].contextWindow, estimated: agents['c-alpha'].windowEstimated, state: agents['c-alpha'].state },
      { model: 'claude-test-1', tokens: 61_515, window: 1_000_000, estimated: true, state: 'working' }
    )
    assert.equal(agents['c-beta'].contextTokens, 250_000)
    assert.deepEqual(
      { model: agents['c-none'].model, tokens: agents['c-none'].contextTokens },
      { model: null, tokens: null }
    )
    // The subagent's rollout is newer but is not the agent's own thread.
    assert.deepEqual(
      { model: agents['x-alpha'].model, tokens: agents['x-alpha'].contextTokens, window: agents['x-alpha'].contextWindow },
      { model: 'gpt-test-1', tokens: 100_800, window: 400_000 }
    )
    assert.deepEqual(
      { tokens: agents['p-alpha'].contextTokens, window: agents['p-alpha'].contextWindow },
      { tokens: 31_000, window: 100_000 }
    )
    assert.equal('ignored' in agents, false)

    if (hasSqlite) {
      assert.deepEqual(
        { tokPerSec: speed['opencode/oc-test-1'].tokPerSec, samples: speed['opencode/oc-test-1'].samples },
        { tokPerSec: 100, samples: 3 }
      )
      assert.deepEqual(
        { model: agents['o-alpha'].model, tokens: agents['o-alpha'].contextTokens, window: agents['o-alpha'].contextWindow },
        { model: 'oc-test-1', tokens: 21_200, window: 200_000 }
      )
    } else {
      assert.match(result.sources.opencode.error, /node:sqlite/)
      assert.equal(agents['o-alpha'].model, null)
    }
    if (hasZstd) {
      assert.equal(speed['dsh/dsh-test-1'].tokPerSec, 100)
      assert.deepEqual(agents['dsh:/work/gamma'], {
        id: null,
        agent: 'dsh',
        cwd: '/work/gamma',
        state: 'idle',
        model: 'dsh-test-1',
        contextTokens: 43_000,
        contextWindow: 128_000,
        windowEstimated: false,
        sessionAt: T0 + 60_000
      })
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('collect: outside the period the speeds go, the context of live agents stays', async () => {
  const home = await buildHome()
  try {
    const result = await collect({ period: '1h', agents: AGENTS }, { home, env: {}, now: T0 + 3 * 60 * 60_000 })
    assert.deepEqual(result.models, [])
    const agents = Object.fromEntries(result.agents.map((row) => [row.id, row]))
    assert.equal(agents['c-alpha'].contextTokens, 61_515)
    assert.equal(agents['x-alpha'].contextTokens, 100_800)
    assert.equal(agents['p-alpha'].contextTokens, 31_000)
    // DSH is listed from its own log, so an idle session leaves the list.
    assert.equal(result.agents.some((row) => row.agent === 'dsh'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('collect: two agents in one directory get the two newest sessions, never the same one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-meter-home-'))
  try {
    const older = fixture('pi/session.jsonl').replaceAll('"totalTokens":31000', '"totalTokens":12000')
    const dir = join(home, '.pi/agent/sessions/--work-alpha--')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'new.jsonl'), fixture('pi/session.jsonl'))
    writeFileSync(join(dir, 'old.jsonl'), older)
    utimesSync(join(dir, 'new.jsonl'), (T0 + 60_000) / 1000, (T0 + 60_000) / 1000)
    utimesSync(join(dir, 'old.jsonl'), (T0 + 30_000) / 1000, (T0 + 30_000) / 1000)
    const agents = [
      { id: 'stale', type: 'pi', cwd: '/work/alpha', state: 'done', updatedAt: 10 },
      { id: 'recent', type: 'pi', cwd: '/work/alpha', state: 'working', updatedAt: 30 },
      { id: 'third', type: 'pi', cwd: '/work/alpha', state: 'done', updatedAt: 5 }
    ]
    const result = await collect({ period: '15m', agents }, { home, env: {}, now: T0 + 2 * 60_000 })
    const rows = Object.fromEntries(result.agents.map((row) => [row.id, row.contextTokens]))
    assert.deepEqual(rows, { recent: 31_000, stale: 12_000, third: null })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('collect: an empty home answers with nothing, not an error', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-meter-home-'))
  try {
    const result = await collect({ period: 'nonsense' }, { home, env: {}, now: T0 })
    assert.equal(result.ok, true)
    assert.equal(result.period, '1h')
    assert.deepEqual(result.models, [])
    assert.deepEqual(result.agents, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
