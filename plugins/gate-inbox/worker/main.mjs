// Gate Inbox worker.
//
// The panel runs on this Orca host; the gates live on the Orca server this host is
// paired with. Plugin host calls only see the local runtime (agent events from a
// paired server never arrive here), so the worker shells out to the orca CLI with
// `--environment`, which is the supported way to read another host's orchestration
// state.
//
// The plugin contributes a status bar item, so Orca keeps this worker running while
// the plugin is enabled. The worker is the only poller: it reads on a timer, updates
// the status bar count, notifies about new gates and tells open panels to re-read.

import { exec, execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLI = process.platform === 'win32' ? 'orca.cmd' : 'orca'
/** Every CLI token we pass is checked against this, so no value can reach a shell. */
const SAFE_ARG = /^[A-Za-z0-9._:@+-]+$/
const CLI_TIMEOUT_MS = 20_000
// A cold sweep is environment-list + run-list + ceil(30 / 8) rounds of gate-list. With
// these timeouts the worst case is 20 + 20 + 4 * 15 = 100 s, inside the 120 s a panel
// request may wait.
const GATE_TIMEOUT_MS = 15_000
const RUNS_TTL_MS = 60_000
const ENVIRONMENTS_TTL_MS = 60_000
const STATUS_ITEM = 'pending'

function cliError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function checked(args) {
  for (const arg of args) {
    if (!SAFE_ARG.test(arg)) {
      throw cliError('invalid_params', `refusing to pass ${JSON.stringify(arg)} to the orca CLI`)
    }
  }
  return args
}

function childEnv() {
  const env = { ...process.env }
  // Orca starts a plugin worker with a reduced environment; the CLI resolves its
  // runtime metadata and saved environments from these, so restore them when absent.
  if (!env.HOME) env.HOME = homedir()
  if (process.platform === 'win32') {
    if (!env.USERPROFILE) env.USERPROFILE = homedir()
    if (!env.APPDATA) env.APPDATA = join(homedir(), 'AppData', 'Roaming')
    if (!env.LOCALAPPDATA) env.LOCALAPPDATA = join(homedir(), 'AppData', 'Local')
  }
  return env
}

/** CLI calls still running, so `deactivate` can stop them. */
const children = new Set()

function runCli(args, timeout = CLI_TIMEOUT_MS) {
  checked(args)
  const options = {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: childEnv()
  }
  return new Promise((resolve, reject) => {
    let child = null
    const done = (error, stdout, stderr) => {
      children.delete(child)
      if (error) {
        // A refused call still prints its JSON envelope on stdout; prefer that message.
        try {
          const refused = JSON.parse(stdout)
          if (refused && refused.ok === false) {
            reject(
              cliError(
                refused.error?.code ?? 'action_failed',
                refused.error?.message ?? 'the orca CLI refused the call'
              )
            )
            return
          }
        } catch {
          // Not JSON: fall through to the process error.
        }
        const detail = (stderr || stdout || '').trim() || error.message
        reject(cliError('action_failed', `orca ${args.slice(0, 2).join(' ')}: ${detail}`))
        return
      }
      let payload
      try {
        payload = JSON.parse(stdout)
      } catch {
        reject(cliError('action_failed', `unexpected output: ${stdout.slice(0, 200)}`))
        return
      }
      if (payload.ok === false) {
        reject(
          cliError(
            payload.error?.code ?? 'action_failed',
            payload.error?.message ?? 'the orca CLI refused the call'
          )
        )
        return
      }
      resolve(payload.result ?? payload)
    }
    if (process.platform === 'win32') {
      // An npm .cmd shim cannot be spawned without a shell. `exec` takes one command
      // string instead of an args array, which also avoids DEP0190; every token above
      // is validated, so the shell only ever sees plain words.
      child = exec(`${CLI} ${args.join(' ')}`, options, done)
    } else {
      child = execFile(CLI, args, options, done)
    }
    children.add(child)
  })
}

let environmentsCache = { at: 0, list: null }

async function listEnvironments(force) {
  if (
    !force &&
    environmentsCache.list &&
    Date.now() - environmentsCache.at < ENVIRONMENTS_TTL_MS
  ) {
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

/** A pairing name may hold spaces or Japanese, which SAFE_ARG refuses; its id (a UUID)
 *  selects the same environment, so pass that and keep the name for display. */
function environmentSelector(entry, preferName) {
  const arg = preferName && SAFE_ARG.test(entry.name) ? entry.name : entry.id
  if (!SAFE_ARG.test(arg)) {
    throw cliError('invalid_params', `環境 ${JSON.stringify(entry.name)} の id を CLI に渡せません`)
  }
  return { arg, label: entry.name || entry.id }
}

/** → `{ arg, label }`: what goes after `--environment`, and what the panel shows. */
async function resolveEnvironment(orca, force) {
  const configured = String((await orca.settings.get('environment')) ?? '').trim()
  if (configured && SAFE_ARG.test(configured)) return { arg: configured, label: configured }
  const environments = await listEnvironments(force)
  if (!configured) {
    const first = environments[0]
    return first ? environmentSelector(first, true) : { arg: 'local', label: 'local' }
  }
  const matches = environments.filter(
    (entry) => entry.id === configured || entry.name === configured
  )
  if (matches.length === 0) {
    throw cliError(
      'invalid_params',
      `設定「Orca サーバー」の ${JSON.stringify(configured)} が保存済みの環境にありません（orca environment list で確認）`
    )
  }
  if (matches.length > 1) {
    throw cliError(
      'invalid_params',
      `${JSON.stringify(configured)} という名前の環境が複数あります。設定には id を入れてください`
    )
  }
  // Reaching here means the configured name failed SAFE_ARG, so only the id can be passed.
  return environmentSelector(matches[0], false)
}

let runsCache = { environment: '', at: 0, runs: [] }

async function listRuns(environment, force) {
  if (
    !force &&
    runsCache.environment === environment &&
    Date.now() - runsCache.at < RUNS_TTL_MS
  ) {
    return runsCache.runs
  }
  const listed = await runCli([
    'orchestration',
    'run-list',
    '--environment',
    environment,
    '--limit',
    '30',
    '--json',
    '--full'
  ])
  const runs = (listed.runs ?? []).map((run) => ({
    id: String(run.id),
    objective: String(run.objective ?? ''),
    updatedAt: String(run.updated_at ?? '')
  }))
  runsCache = { environment, at: Date.now(), runs }
  return runs
}

function parseOptions(raw) {
  if (Array.isArray(raw)) return raw.map((value) => String(value))
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map((value) => String(value))
    } catch {
      // A gate whose options are not JSON still renders; it just shows no buttons.
    }
  }
  return []
}

/** Accepts the CLI's `--full` row (snake_case, options as a JSON string) and its concise
 *  view (camelCase, options already parsed, no timestamps). */
function parseGate(row) {
  const [firstLine = '', ...rest] = String(row.question ?? '').split('\n')
  const numbered = /^#(\d+)\s*(.*)$/.exec(firstLine.trim())
  return {
    id: String(row.id),
    taskId: String(row.task_id ?? row.taskId ?? ''),
    number: numbered ? Number(numbered[1]) : null,
    title: (numbered ? numbered[2] : firstLine).trim(),
    body: rest.join('\n').trim(),
    options: parseOptions(row.options),
    createdAt: String(row.created_at ?? row.createdAt ?? '')
  }
}

async function listGates(environment, runId) {
  const listed = await runCli(
    [
      'orchestration',
      'gate-list',
      '--environment',
      environment,
      '--run',
      runId,
      '--status',
      'pending',
      '--json',
      '--full'
    ],
    GATE_TIMEOUT_MS
  )
  // Oldest first, like the chat above it: the thing that has waited longest is at the top.
  return (listed.gates ?? [])
    .map(parseGate)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
}

/** Runs `worker` over `items` with at most `limit` in flight, keeping the order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await worker(items[index])
      }
    })
  )
  return results
}

// Gate discovery costs one CLI call per Run, and `gate-create` does not bump a Run's
// `updated_at`, so there is no cheaper way to notice a Run that just got gates. Sweep
// every Run now and then, and between sweeps re-read only the Runs that have gates.
const SWEEP_MS = 90_000
const SWEEP_CONCURRENCY = 8

function emptySweep(environment) {
  return {
    environment,
    at: 0,
    /** Run id → its gates from the last read that succeeded. No entry: never read. */
    gates: new Map(),
    /** Run id → why its latest read failed. Cleared by the next success. */
    errors: new Map(),
    /** Gate ids already counted as known; null until the first sweep, which notifies nothing. */
    seen: null
  }
}

let sweep = emptySweep('')

async function readGates(environment, run) {
  try {
    return { gates: await listGates(environment, run.id) }
  } catch (error) {
    return { error: `${error.code ?? 'error'}: ${error.message ?? error}` }
  }
}

async function readSweep(orca, environment, runs, force) {
  // Another server's gates are not "the previous value" of this one's.
  if (sweep.environment !== environment) sweep = emptySweep(environment)
  const full = force || Date.now() - sweep.at > SWEEP_MS
  const targets = full
    ? runs
    : runs.filter(
        // A Run whose read failed is retried every poll, not left wrong until the next sweep.
        (run) => (sweep.gates.get(run.id) ?? []).length > 0 || sweep.errors.has(run.id)
      )
  const results = await mapLimit(targets, SWEEP_CONCURRENCY, (run) => readGates(environment, run))
  targets.forEach((run, index) => {
    const result = results[index]
    if (result.error !== undefined) {
      // Keep what the last good read said; a failed read is not "no gates". A failing
      // Run is retried every poll, so log it when the reason changes, not every time.
      if (sweep.errors.get(run.id) !== result.error) {
        orca.log(`gate-list ${run.id} ERR ${result.error}`)
      }
      sweep.errors.set(run.id, result.error)
      return
    }
    // A Run that has only ever failed held these gates before the baseline was taken,
    // so they are not news.
    const firstGoodRead = sweep.errors.has(run.id) && !sweep.gates.has(run.id)
    if (firstGoodRead && sweep.seen) result.gates.forEach((gate) => sweep.seen.add(gate.id))
    sweep.gates.set(run.id, result.gates)
    sweep.errors.delete(run.id)
  })
  if (full) {
    sweep.at = Date.now()
    const listed = new Set(runs.map((run) => run.id))
    for (const id of [...sweep.gates.keys()]) if (!listed.has(id)) sweep.gates.delete(id)
    for (const id of [...sweep.errors.keys()]) if (!listed.has(id)) sweep.errors.delete(id)
  }
}

/** → `{ state, fresh }`: what the panel renders, and the gates nobody has been told about. */
async function buildState(orca, force) {
  const environment = await resolveEnvironment(orca, force)
  const runs = await listRuns(environment.arg, force)
  await readSweep(orca, environment.arg, runs, force)
  const pinned = String((await orca.settings.get('runId')) ?? '').trim()
  const inView = runs.filter((run) => !pinned || run.id === pinned)
  const groups = inView
    .map((run) => ({ run, gates: sweep.gates.get(run.id) ?? [] }))
    .filter((group) => group.gates.length > 0)
    .map((group) => ({
      runId: group.run.id,
      objective: group.run.objective,
      updatedAt: group.run.updatedAt,
      gates: group.gates,
      // The latest read failed, so these are the gates of the read before it.
      stale: sweep.errors.has(group.run.id)
    }))
    // The Run that has waited longest comes first, like the gates inside it.
    .sort((left, right) =>
      String(left.gates[0]?.createdAt ?? '').localeCompare(String(right.gates[0]?.createdAt ?? ''))
    )
  const errors = inView
    .filter((run) => sweep.errors.has(run.id))
    .map((run) => ({ runId: run.id, objective: run.objective, message: sweep.errors.get(run.id) }))

  // Every pending gate on the server, whatever the Run pin shows.
  const gateIds = runs.flatMap((run) => (sweep.gates.get(run.id) ?? []).map((gate) => gate.id))
  const fresh = []
  if (!sweep.seen) {
    sweep.seen = new Set(gateIds)
  } else {
    for (const group of groups) {
      for (const gate of group.gates) if (!sweep.seen.has(gate.id)) fresh.push(gate)
    }
    // Only ever grows: a gate hidden by the pin today must not notify when the pin moves.
    for (const id of gateIds) sweep.seen.add(id)
  }

  const state = {
    environment: environment.label,
    groups,
    errors,
    gateIds,
    // The panel drops stored answers for ids missing from `gateIds`, so only say the list
    // is whole when every Run was read and the server listed Runs at all.
    complete: sweep.errors.size === 0 && runs.length > 0,
    fetchedAt: Date.now()
  }
  return { state, fresh }
}

function hostHas(orca, method, sinceMinor) {
  if (typeof orca.host?.has === 'function') return orca.host.has(method)
  return orca.api.major > 1 || orca.api.minor >= sinceMinor
}

/** Status bar text and tooltips are one line with a length limit. */
function oneLine(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const countGates = (state) => state.groups.reduce((total, group) => total + group.gates.length, 0)

/** The worker `activate` started; a build that outlives `deactivate` must not publish. */
let active = null
let timer = null
let pollMs = 20_000
/** Bumped when a setting that changes what is read changes. */
let generation = 0
/** The one build in flight: `{ promise, force, generation }`. */
let building = null
/** The one forced build waiting for the build in flight to finish. */
let forcedNext = null
/** What the latest build ended with: `{ at, state }` or `{ at, error: { code, message } }`. */
let last = null
let lastCount = null
let lastStatusKey = ''
let lastLogLine = ''
let lastPostError = ''

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

/** Every field goes out each time: an omitted one would keep its old value, such as a
 *  warning tone from a failure that has since cleared. */
function publish(orca, state, error) {
  if (active !== orca) return
  if (error) {
    logOnce(orca, `state ERR ${error.code ?? '-'} ${error.message}`)
    updateStatusBar(orca, {
      text: lastCount ? `${lastCount}件待ち` : '取得失敗',
      tone: 'warning',
      tooltip: oneLine(`Gate Inbox: 読み取りに失敗しました（${error.message}）`, 256),
      visible: true
    })
  } else {
    const count = countGates(state)
    lastCount = count
    logOnce(
      orca,
      `state env=${state.environment} runs=${state.groups.length} gates=${count} errors=${state.errors.length}`
    )
    const failed = state.errors.length
    updateStatusBar(orca, {
      text: count === 0 && failed ? '取得失敗' : `${count}件待ち`,
      tone: failed ? 'warning' : 'accent',
      tooltip: oneLine(
        failed
          ? `Gate Inbox: ${failed}件の Run を読めませんでした（前回の値を表示中）: ${state.errors[0].message}`
          : `Gate Inbox: 確認待ち ${count}件（${state.environment}）`,
        256
      ),
      // Nothing to answer and nothing wrong: stay out of the way.
      visible: count > 0 || failed > 0
    })
  }
  try {
    // Small on purpose: a post is capped at 256 KiB, so the panel asks for the state.
    orca.panels.post('state.changed', { at: Date.now() })
  } catch (postError) {
    // Posted every poll, so a host that refuses it must not fill the log.
    if (postError.message !== lastPostError) orca.log(`post ERR ${postError.message}`)
    lastPostError = postError.message
  }
}

async function notify(orca, fresh) {
  if (fresh.length === 0 || active !== orca) return
  if (!orca.grantedCapabilities.includes('notifications:show')) return
  if (!hostHas(orca, 'notifications.show', 0)) return
  try {
    if ((await orca.settings.get('notify')) === false) return
    const lines = fresh
      .slice(0, 5)
      .map((gate) => oneLine(`${gate.number === null ? '' : `#${gate.number} `}${gate.title}`, 150))
    if (fresh.length > lines.length) lines.push(`ほか ${fresh.length - lines.length}件`)
    // One notification per poll, however many gates arrived.
    await orca.host.call('notifications.show', {
      title: `新しい確認待ち ${fresh.length}件`,
      body: lines.join('\n').slice(0, 1000)
    })
  } catch (error) {
    orca.log(`notifications.show ERR ${error.code ?? '-'} ${error.message}`)
  }
}

async function runBuild(orca, force) {
  try {
    const { state, fresh } = await buildState(orca, force)
    if (active === orca) last = { at: Date.now(), state }
    publish(orca, state, null)
    void notify(orca, fresh)
    return state
  } catch (error) {
    if (active === orca) {
      last = {
        at: Date.now(),
        error: { code: error.code ?? 'action_failed', message: String(error.message ?? error) }
      }
    }
    publish(orca, null, error)
    throw error
  }
}

function startBuild(orca, force) {
  const mine = { force, generation, promise: null }
  mine.promise = runBuild(orca, force).finally(() => {
    if (building === mine) building = null
  })
  building = mine
  return mine.promise
}

/** Every reader (the timer, each panel, a settings change) goes through here, so there is
 *  never more than one sweep running. `cached` answers from the latest build when it is
 *  recent enough; the timer never passes it. */
async function getState(orca, { force = false, cached = false } = {}) {
  if (building) {
    const coversForce = building.force && building.generation === generation
    if (!force || coversForce) return building.promise
    // The build in flight may have started before the click or the settings change, so
    // it cannot answer a forced read. Queue one forced build behind it, shared by all.
    forcedNext ??= (async () => {
      while (building) await building.promise.catch(() => {})
      forcedNext = null
      return startBuild(orca, true)
    })()
    return forcedNext
  }
  if (!force && cached && last && Date.now() - last.at < pollMs * 2) {
    if (last.error) throw cliError(last.error.code, last.error.message)
    return last.state
  }
  return startBuild(orca, force)
}

async function readPollMs(orca) {
  try {
    const seconds = Number(await orca.settings.get('refreshSeconds')) || 20
    pollMs = Math.min(600, Math.max(5, seconds)) * 1000
  } catch {
    // Keep the interval in use.
  }
}

function schedule(orca) {
  clearTimeout(timer)
  if (active !== orca) return
  timer = setTimeout(() => void tick(orca, false), pollMs)
}

async function tick(orca, force) {
  try {
    await getState(orca, { force })
  } catch {
    // Already logged and shown in the status bar; the next tick tries again.
  }
  if (active !== orca) return
  await readPollMs(orca)
  schedule(orca)
}

export default function activate(orca) {
  orca.log(
    `activate host-api ${orca.api.major}.${orca.api.minor} granted=${orca.grantedCapabilities.join(',')}`
  )
  active = orca
  generation = 0
  building = null
  forcedNext = null
  last = null
  lastCount = null
  lastStatusKey = ''
  lastLogLine = ''
  lastPostError = ''
  sweep = emptySweep('')

  // The manifest cannot declare an item hidden, so hide it until the first count is in.
  updateStatusBar(orca, {
    text: '確認待ち',
    tone: 'neutral',
    tooltip: 'Gate Inbox: 読み込み中',
    visible: false
  })

  // Not tied to the asking panel's abort signal: the build is shared with the timer and
  // with other panels.
  orca.panels.handle('state.get', (input) =>
    getState(orca, { force: input?.force === true, cached: true })
  )

  if (typeof orca.settings.onDidChange === 'function') {
    orca.settings.onDidChange(({ key }) => {
      if (active !== orca) return
      if (key === 'environment' || key === 'runId') {
        generation += 1
        clearTimeout(timer)
        void tick(orca, true)
      } else if (key === 'refreshSeconds') {
        void readPollMs(orca).then(() => schedule(orca))
      }
    })
  }

  void readPollMs(orca).then(() => tick(orca, false))
}

export function deactivate() {
  active = null
  clearTimeout(timer)
  timer = null
  for (const child of children) child.kill()
  children.clear()
}
