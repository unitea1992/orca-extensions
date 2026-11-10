// Gate Inbox worker.
//
// The panel runs on this Orca host; the gates live on the Orca server this host is
// paired with. Plugin host calls only see the local runtime (agent events from a
// paired server never arrive here), so the worker shells out to the orca CLI with
// `--environment`, which is the supported way to read another host's orchestration
// state. The panel asks for state and the worker answers; nothing runs while no
// panel is open.

import { exec, execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLI = process.platform === 'win32' ? 'orca.cmd' : 'orca'
/** Every CLI token we pass is checked against this, so no value can reach a shell. */
const SAFE_ARG = /^[A-Za-z0-9._:@+-]+$/
const CLI_TIMEOUT_MS = 20_000
const RUNS_TTL_MS = 60_000

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

function runCli(args) {
  checked(args)
  const options = {
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: childEnv()
  }
  return new Promise((resolve, reject) => {
    const done = (error, stdout, stderr) => {
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
      exec(`${CLI} ${args.join(' ')}`, options, done)
    } else {
      execFile(CLI, args, options, done)
    }
  })
}

async function resolveEnvironment(orca) {
  const configured = String((await orca.settings.get('environment')) ?? '').trim()
  if (configured) return configured
  const listed = await runCli(['environment', 'list', '--json'])
  const first = (listed.environments ?? [])[0]
  return first ? String(first.name ?? first.id) : 'local'
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
  const listed = await runCli([
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
  ])
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

let sweep = { environment: '', at: 0, gates: new Map() }

async function readGates(environment, run, orca) {
  try {
    return await listGates(environment, run.id)
  } catch (error) {
    orca.log(`gate-list ${run.id} ERR ${error.code ?? '-'} ${error.message}`)
    return null
  }
}

async function gatesByRun(orca, environment, runs, force) {
  const stale =
    force || sweep.environment !== environment || Date.now() - sweep.at > SWEEP_MS
  if (stale) {
    const lists = await mapLimit(runs, SWEEP_CONCURRENCY, (run) => readGates(environment, run, orca))
    sweep = {
      environment,
      at: Date.now(),
      gates: new Map(runs.map((run, index) => [run.id, lists[index]]))
    }
    return sweep.gates
  }
  const watched = runs.filter((run) => (sweep.gates.get(run.id) ?? []).length > 0)
  if (watched.length === 0) return sweep.gates
  const lists = await mapLimit(watched, SWEEP_CONCURRENCY, (run) =>
    readGates(environment, run, orca)
  )
  watched.forEach((run, index) => sweep.gates.set(run.id, lists[index]))
  return sweep.gates
}

async function buildState(orca, request) {
  const environment = await resolveEnvironment(orca)
  const runs = await listRuns(environment, request.force === true)
  const gates = await gatesByRun(orca, environment, runs, request.force === true)
  const pinned = String((await orca.settings.get('runId')) ?? '').trim()
  const groups = runs
    .filter((run) => !pinned || run.id === pinned)
    .map((run) => ({ run, gates: gates.get(run.id) ?? [] }))
    .filter((group) => group.gates.length > 0)
    .map((group) => ({
      runId: group.run.id,
      objective: group.run.objective,
      updatedAt: group.run.updatedAt,
      gates: group.gates
    }))
    // The Run that has waited longest comes first, like the gates inside it.
    .sort((left, right) =>
      String(left.gates[0]?.createdAt ?? '').localeCompare(String(right.gates[0]?.createdAt ?? ''))
    )
  return { environment, groups, fetchedAt: Date.now() }
}

export default function activate(orca) {
  orca.log(
    `activate host-api ${orca.api.major}.${orca.api.minor} granted=${orca.grantedCapabilities.join(',')}`
  )

  orca.panels.handle('state.get', async (input) => {
    try {
      const state = await buildState(orca, input ?? {})
      const gates = state.groups.reduce((total, group) => total + group.gates.length, 0)
      orca.log(`state env=${state.environment} runs=${state.groups.length} gates=${gates}`)
      return state
    } catch (error) {
      orca.log(`state ERR ${error.code ?? '-'} ${error.message}`)
      throw error
    }
  })
}

export function deactivate() {
  // Nothing to flush: every read is a one-shot CLI call.
}
