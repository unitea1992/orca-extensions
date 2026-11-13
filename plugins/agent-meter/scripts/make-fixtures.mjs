// Writes test/fixtures. Everything here is invented: ids, model names, paths and text.
// Run `node scripts/make-fixtures.mjs` after changing a shape, and commit the result.
// It lives outside test/ because `node --test` runs every module under a test folder.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')

/** Every fixture is timed from here; the tests use the same instant. */
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0)
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString()

function write(name, records, tail = '') {
  const file = join(here, name)
  mkdirSync(dirname(file), { recursive: true })
  const lines = records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record)))
  writeFileSync(file, `${lines.join('\n')}\n${tail}`)
}

// --- Claude Code -----------------------------------------------------------

function claudeUsage(output, input, cacheRead, cacheCreation) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation
  }
}

function claudeAssistant({ uuid, parent, at, id, model = 'claude-test-1', usage, block = 'text', effort = 'high', extra = {} }) {
  return {
    type: 'assistant',
    uuid,
    parentUuid: parent,
    timestamp: iso(at),
    isSidechain: false,
    sessionId: 'sess-main',
    ...(effort ? { effort } : {}),
    message: { id, model, role: 'assistant', content: [{ type: block }], stop_reason: 'end_turn', usage },
    ...extra
  }
}

function claudeUser(uuid, parent, at, extra = {}) {
  return {
    type: 'user',
    uuid,
    parentUuid: parent,
    timestamp: iso(at),
    isSidechain: false,
    message: { role: 'user', content: 'fixture prompt' },
    ...extra
  }
}

write('claude/main.jsonl', [
  { type: 'ai-title', sessionId: 'sess-main', aiTitle: 'fixture' },
  claudeUser('u1', null, 0),
  { type: 'api-request-blob', hash: 'h1', message: { role: 'system', content: 'x'.repeat(2000) } },
  { type: 'api-request', id: 'req-1', timestamp: iso(200), params: { model: 'claude-test-1', betas: ['fixture-beta'] } },
  // msg_1 arrives as two blocks; the request it points to started at +200 ms.
  claudeAssistant({
    uuid: 'a1',
    parent: 'u1',
    at: 2000,
    id: 'msg_1',
    block: 'thinking',
    usage: claudeUsage(40, 10, 50_000, 1_000),
    extra: { requestRef: 'req-1' }
  }),
  claudeAssistant({
    uuid: 'a2',
    parent: 'a1',
    at: 4200,
    id: 'msg_1',
    block: 'tool_use',
    usage: claudeUsage(400, 10, 50_000, 1_000),
    extra: { requestRef: 'req-1' }
  }),
  claudeUser('u2', 'a2', 5000),
  { type: 'attachment', uuid: 'at1', parentUuid: 'u2', timestamp: iso(5100), isSidechain: false, attachment: { type: 'fixture' } },
  // msg_2 has no requestRef: it started when the record it answers (u2, past the attachment) was written.
  claudeAssistant({ uuid: 'a3', parent: 'at1', at: 8000, id: 'msg_2', usage: claudeUsage(150, 12, 60_000, 2_000) }),
  // A sidechain request: counted for speed, never for the session's context.
  claudeAssistant({
    uuid: 's1',
    parent: 'a3',
    at: 9000,
    id: 'msg_3',
    usage: claudeUsage(200, 5, 500_000, 0),
    extra: { isSidechain: true }
  }),
  claudeAssistant({ uuid: 'x1', parent: 's1', at: 10_000, id: 'msg_synthetic', model: '<synthetic>', usage: claudeUsage(0, 0, 0, 0) }),
  claudeUser('u3', 'a3', 11_900),
  // Too short to say anything about speed, but it is the latest main-chain request.
  claudeAssistant({ uuid: 'a4', parent: 'u3', at: 12_000, id: 'msg_4', usage: claudeUsage(20, 15, 61_000, 500) })
], '{"type":"assistant","uuid":"cut')

write('claude/subagent.jsonl', [
  claudeUser('su1', null, 60_000, { isSidechain: true }),
  claudeAssistant({
    uuid: 'sa1',
    parent: 'su1',
    at: 62_000,
    id: 'msg_sub_1',
    model: 'claude-test-mini',
    effort: null,
    usage: claudeUsage(300, 8, 9_000, 0),
    extra: { isSidechain: true }
  })
])

// Past 200k: this account runs claude-test-1 with the wide window. Another effort than
// the main session, so the same model shows a second speed.
write('claude/wide.jsonl', [
  claudeUser('w1', null, 20_000),
  claudeAssistant({ uuid: 'w2', parent: 'w1', at: 23_000, id: 'msg_w1', effort: 'medium', usage: claudeUsage(300, 20, 249_000, 980) })
])

// --- Codex -----------------------------------------------------------------

const codex = (at, type, payload) => ({ timestamp: iso(at), type, payload })
const tokenCount = (at, total, last, extra = {}) =>
  codex(at, 'event_msg', {
    type: 'token_count',
    info: last === null ? null : { total_token_usage: { total_tokens: total }, last_token_usage: last, ...extra },
    rate_limits: {}
  })

write('codex/rollout-new.jsonl', [
  codex(0, 'session_meta', { id: 'thread-new', cwd: '/work/alpha', originator: 'fixture', source: 'cli', thread_source: 'user', base_instructions: 'x'.repeat(500) }),
  codex(500, 'turn_context', { model: 'gpt-test-1', effort: 'high', cwd: '/work/alpha' }),
  codex(1000, 'event_msg', { type: 'task_started', model_context_window: 400_000 }),
  codex(3000, 'response_item', { type: 'reasoning' }),
  codex(5000, 'response_item', { type: 'function_call', name: 'fixture_tool' }),
  codex(5100, 'token_usage_record', { response_id: 'resp-1' }),
  // The tool ran for 30 s; none of it belongs to the response.
  codex(35_000, 'response_item', { type: 'function_call_output' }),
  tokenCount(35_010, 100_500, { output_tokens: 410, reasoning_output_tokens: 100, total_tokens: 100_500 }, { last_usage_includes_reasoning: true, model_context_window: 400_000 }),
  // Same totals again: only the rate limits moved.
  tokenCount(35_500, 100_500, { output_tokens: 410, reasoning_output_tokens: 100, total_tokens: 100_500 }, { last_usage_includes_reasoning: true, model_context_window: 400_000 }),
  codex(38_000, 'response_item', { type: 'message', role: 'assistant' }),
  codex(38_010, 'token_usage_record', { response_id: 'resp-2' }),
  tokenCount(38_020, 201_300, { output_tokens: 150, reasoning_output_tokens: 0, total_tokens: 100_800 }, { last_usage_includes_reasoning: true, model_context_window: 400_000 }),
  codex(38_030, 'event_msg', { type: 'task_complete', duration_ms: 37_030, time_to_first_token_ms: 900 }),
  tokenCount(39_000, 0, null)
])

// An older rollout: no token_usage_record, reasoning reported apart from output, and
// token_count written when the response ends, before its tool runs.
write('codex/rollout-old.jsonl', [
  codex(600_000, 'session_meta', { id: 'thread-old', cwd: '/work/beta', originator: 'fixture', source: 'cli' }),
  codex(600_100, 'turn_context', { model: 'gpt-test-2' }),
  codex(600_200, 'event_msg', { type: 'task_started', model_context_window: 200_000 }),
  codex(602_200, 'response_item', { type: 'function_call', name: 'fixture_tool' }),
  tokenCount(602_250, 5000, { output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 5000 }, { last_usage_includes_reasoning: false }),
  // The tool ran for about 8 s; the next response starts when its output is in.
  codex(610_000, 'response_item', { type: 'function_call_output' }),
  codex(612_000, 'response_item', { type: 'message', role: 'assistant' }),
  tokenCount(612_050, 10_200, { output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 5200 }, { last_usage_includes_reasoning: false })
])

// Codex's automatic review of a command: a child thread under an internal model name.
write('codex/rollout-subagent.jsonl', [
  codex(40_000, 'session_meta', { id: 'thread-sub', cwd: '/work/alpha', originator: 'fixture', source: { subagent: { other: 'fixture' } }, thread_source: 'guardian_review', parent_thread_id: 'thread-new' }),
  codex(40_100, 'turn_context', { model: 'codex-auto-review' }),
  codex(40_200, 'event_msg', { type: 'task_started', model_context_window: 100_000 }),
  codex(41_200, 'response_item', { type: 'message', role: 'assistant' }),
  codex(41_200, 'token_usage_record', { response_id: 'resp-s' }),
  tokenCount(41_210, 900, { output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 900 }, { last_usage_includes_reasoning: true })
])

// A child thread marked only by its parent, running an ordinary model.
write('codex/rollout-child.jsonl', [
  codex(50_000, 'session_meta', { id: 'thread-child', cwd: '/work/alpha', originator: 'fixture', source: 'cli', parent_thread_id: 'thread-new' }),
  codex(50_100, 'turn_context', { model: 'gpt-test-1', effort: 'low' }),
  codex(50_200, 'event_msg', { type: 'task_started', model_context_window: 400_000 }),
  codex(52_200, 'response_item', { type: 'message', role: 'assistant' }),
  codex(52_200, 'token_usage_record', { response_id: 'resp-c' }),
  tokenCount(52_210, 390_000, { output_tokens: 250, reasoning_output_tokens: 0, total_tokens: 390_000 }, { last_usage_includes_reasoning: true, model_context_window: 400_000 })
])

// --- pi ----------------------------------------------------------------------

const piUsage = (input, output, reasoning, cacheRead) => ({
  input,
  output,
  reasoning,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output + cacheRead
})
const piAssistant = (id, at, durationMs, usage, extra = {}) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: iso(at),
  message: { role: 'assistant', content: [], provider: 'testprov', model: 'local-test-1', usage, durationMs, stopReason: 'stop', thinkingLevel: 'high', ...extra }
})

write('pi/session.jsonl', [
  { type: 'session', version: 3, id: 'pi-session', timestamp: iso(0), cwd: '/work/alpha' },
  { type: 'model_change', id: 'm1', parentId: null, timestamp: iso(10), provider: 'testprov', modelId: 'local-test-1' },
  { type: 'message', id: 'pu1', parentId: null, timestamp: iso(1000), message: { role: 'user', content: 'fixture prompt' } },
  // reasoning is part of output: 200 tokens in 4 s.
  piAssistant('pa1', 10_000, 4000, piUsage(100, 200, 150, 30_000)),
  { type: 'message', id: 'pt1', parentId: null, timestamp: iso(11_000), message: { role: 'toolResult', toolName: 'fixture', durationMs: 9000 } },
  piAssistant('pa2', 14_000, 2000, piUsage(400, 300, 0, 30_300)),
  piAssistant('pa3', 15_000, 100, piUsage(0, 0, 0, 0), { stopReason: 'error' })
])

writeFileSync(
  join(here, 'pi/models.json'),
  `${JSON.stringify({ providers: { testprov: { api: 'fixture', models: [{ id: 'local-test-1', name: 'Fixture', contextWindow: 100_000, maxTokens: 8000 }] } } }, null, 2)}\n`
)

// --- OpenCode ----------------------------------------------------------------

const ocMessage = (session, seq, at, durationMs, tokens, variant = 'high') => ({
  session_id: session,
  type: 'assistant',
  seq,
  time_created: T0 + at,
  data: {
    time: durationMs === null ? { created: T0 + at } : { created: T0 + at, streamed: T0 + at + durationMs, completed: T0 + at + durationMs + 800 },
    model: { id: 'oc-test-1', providerID: 'ocprov', variant },
    tokens,
    content: []
  }
})
const ocTokens = (input, output, reasoning, cacheRead) => ({ input, output, reasoning, cache: { read: cacheRead, write: 0 } })

mkdirSync(join(here, 'opencode'), { recursive: true })
writeFileSync(
  join(here, 'opencode/rows.json'),
  `${JSON.stringify(
    {
      sessions: [
        { id: 'ses_parent', directory: '/work/alpha', parent_id: null, time_updated: T0 + 20_000 },
        // A subagent's session, newer than its parent: never an agent's own context.
        { id: 'ses_child', directory: '/work/alpha', parent_id: 'ses_parent', time_updated: T0 + 30_000 }
      ],
      messages: [
        { session_id: 'ses_parent', type: 'user', seq: 1, time_created: T0 + 1000, data: { content: [] } },
        // Reasoning is counted apart from output: 100 + 100 tokens in 4 s.
        ocMessage('ses_parent', 2, 2000, 4000, ocTokens(500, 100, 100, 20_000)),
        ocMessage('ses_parent', 3, 8000, 2000, ocTokens(700, 300, 0, 20_500)),
        // Still streaming: no usage yet.
        ocMessage('ses_parent', 4, 12_000, null, ocTokens(0, 0, 0, 0)),
        // `default` is no variant chosen: no effort to show.
        ocMessage('ses_child', 1, 25_000, 1000, ocTokens(50, 100, 0, 90_000), 'default')
      ]
    },
    null,
    2
  )}\n`
)
writeFileSync(
  join(here, 'opencode/opencode.json'),
  `{
  // A config file may hold comments and trailing commas.
  "provider": {
    "ocprov": {
      "models": {
        "oc-test-1": { "limit": { "context": 200000, "output": 8000 } },
      },
    },
  },
}
`
)

// --- DSH ---------------------------------------------------------------------

const dsh = (seq, at, type, data) => ({ type, seq, time: T0 + at, data })

write('dsh/session.jsonl', [
  { type: 'session', version: 4, id: 'dsh-session', createdAt: T0, cwd: '/work/gamma', isSeeded: false, delegationDepth: 0 },
  dsh(1, 0, 'turn/start', { turn: 0 }),
  dsh(2, 0, 'step/start', { turn: 0, step: 0 }),
  dsh(3, 50, 'request/header', { header: { config: { provider: 'dshprov', model: 'dsh-test-1', reasoningEffort: 'max' } }, reason: 'fixture' }),
  dsh(4, 100, 'request/context', { provider: 'dshprov', model: 'dsh-test-1', contextWindow: 128_000 }),
  // An abandoned attempt: a stream but no usage.
  dsh(5, 300, 'assistant/attempt', { turn: 0, step: 0, stream: [{ type: 'chunk', time: T0 + 300, chunk: { type: 'error' } }] }),
  dsh(6, 4200, 'assistant/message', {
    turn: 0,
    step: 0,
    message: { role: 'assistant', content: [] },
    usage: { input: 1000, output: 300, think: 100, cacheRead: 40_000, cacheWrite: 0 },
    stream: [
      { type: 'reasoning-chunks', index: 0, time0: T0 + 600, dt: [100, 100], texts: ['a', 'b', 'c'] },
      { type: 'text-chunks', index: 1, time0: T0 + 900, dt: [1000, 1000, 1200], texts: ['a', 'b', 'c', 'd'] },
      { type: 'chunk', time: T0 + 4100, chunk: { type: 'finish' } }
    ]
  }),
  dsh(7, 4300, 'step/end', { turn: 0, step: 0 }),
  dsh(8, 10_000, 'step/start', { turn: 0, step: 1 }),
  dsh(9, 10_100, 'request/context', { provider: 'dshprov', model: 'dsh-test-1', contextWindow: 128_000 }),
  // The other spelling of the reasoning field, and no stream: timed by the event itself.
  dsh(10, 12_100, 'assistant/message', {
    turn: 0,
    step: 1,
    message: { role: 'assistant', content: [] },
    usage: { input: 2000, output: 100, reasoning: 100, cacheRead: 41_000, cacheWrite: 0 }
  }),
  dsh(11, 12_200, 'turn/end', { turn: 0, reason: { kind: 'done' } })
])

// --- Orca CLI ----------------------------------------------------------------

writeFileSync(
  join(here, 'worktree-ps.json'),
  `${JSON.stringify(
    {
      worktrees: [
        {
          path: '/work/alpha',
          repo: 'alpha-repo',
          displayName: 'alpha',
          agents: [
            { paneKey: 'tab-1:leaf-1', agentType: 'claude', state: 'working', updatedAt: T0 + 5000, children: [] },
            { paneKey: 'structured-agent-session-1:pane-1', agentType: 'codex', state: 'done', updatedAt: T0 + 4000 },
            { paneKey: 'tab-9:leaf-9', agentType: 'other-agent', state: 'working', updatedAt: T0 }
          ]
        },
        { path: '/work/beta', displayName: '', agents: [{ paneKey: 'tab-2:leaf-2', agentType: 'pi', state: 'idle', updatedAt: T0 }] },
        {
          // Three agents in one workspace: one titled by Orca, one by its terminal, one untitled.
          // A repository's main checkout: the folder is the repository, the workspace `develop`.
          path: '/work/delta',
          repo: 'delta',
          displayName: 'develop',
          agents: [
            { paneKey: 'tab-5:leaf-b', agentType: 'claude', state: 'done', displayName: null, taskTitle: null, updatedAt: T0 },
            { paneKey: 'tab-5:leaf-a', agentType: 'claude', state: 'done', displayName: 'Fix   login\nflow', taskTitle: 'Fix login flow', updatedAt: T0 },
            { paneKey: 'tab-6:leaf-a', agentType: 'codex', state: 'done', displayName: null, taskTitle: null, updatedAt: T0 }
          ]
        },
        { path: '/work/empty', displayName: 'empty', agents: [] }
      ],
      totalCount: 4,
      truncated: false
    },
    null,
    2
  )}\n`
)
writeFileSync(
  join(here, 'terminal-list.json'),
  `${JSON.stringify(
    {
      terminals: [
        { handle: 'term_one', tabId: 'tab-1', leafId: 'leaf-1', title: null, worktreePath: '/work/alpha' },
        { handle: 'term_three', tabId: 'tab-6', leafId: 'leaf-a', title: 'codex: review', worktreePath: '/work/delta' }
      ]
    },
    null,
    2
  )}\n`
)
