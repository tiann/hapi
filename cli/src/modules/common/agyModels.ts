import { spawn } from 'node:child_process'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import { AGY_MODEL_LABELS, AGY_MODEL_PRESETS } from '@hapi/protocol'
import type { AgyModelsResponse } from '@hapi/protocol/apiTypes'

export type ListAgyModelsResponse = AgyModelsResponse

const AUTH_REQUIRED_PATTERNS = [
    'Authentication required',
    'Please sign in',
    'accounts.google.com/o/oauth2/auth'
]

const PROBE_TIMEOUT_MS = 15_000

type AgyCatalog = NonNullable<AgyModelsResponse['availableModels']>

// A probe is a whole agy invocation, so the catalog is served from the last one
// agy answered. STALE_TTL_MS is the outer bound on that trust: past it the
// listing stops standing in for the machine even if probes keep failing.
const FRESH_TTL_MS = 10 * 60_000
const STALE_TTL_MS = 24 * 60 * 60_000

// Floor between probes after one comes back empty. On a machine where agy hangs
// on sign-in each attempt costs PROBE_TIMEOUT_MS, and both pickers ask.
const PROBE_BACKOFF_MS = 60_000

interface CachedCatalog {
    models: AgyCatalog
    fetchedAt: number
}

// Only a live listing lands here, never the hardcoded mirror: the mirror is a
// stand-in, not something the machine observed, and caching it would pin the
// picker to it for a whole TTL after a single timeout.
let cachedCatalog: CachedCatalog | null = null

// Kept for two reasons: it rate-limits retries, and an auth failure has to reach
// the user even while a cached listing is still being served.
let lastFailedProbe: { at: number; result: AgyCatalogFetch } | null = null

// Registered only by the machine daemon; a session process has no route out.
let catalogChangeListener: (() => void) | null = null

export function setAgyCatalogChangeListener(listener: (() => void) | null): void {
    catalogChangeListener = listener
}

function notifyCatalogChanged(): void {
    try {
        catalogChangeListener?.()
    } catch {
        // Best effort: failing to announce a new catalog must not fail the probe.
    }
}

// Not the same as "nothing is cached": a machine whose agy is signed out has
// been answering from the mirror all along, so its first real listing is a
// change somebody needs to hear about. Until anything has been handed out
// though, a probe landing has nothing to correct.
let hasServedAnswer = false

// The machine daemon owns `machineId:listAgyModels`, so this module runs once
// per machine — hence no keying.
let inflight: Promise<AgyCatalogFetch> | null = null

// What one round of asking agy produced. `unavailable` covers every way the
// listing failed to arrive (spawn failure, timeout, output neither parser
// could read) — none of them say anything about the catalog itself.
type AgyCatalogFetch =
    | { kind: 'live'; models: AgyCatalog }
    | { kind: 'auth-error'; error: string }
    | { kind: 'unavailable' }

// Hardcoded list — used as a FALLBACK only (when `agy models` can't be reached)
// and as the source of truth for name→id mapping of known models.
function buildModelList(): AgyModelsResponse['availableModels'] {
    return AGY_MODEL_PRESETS.map((id) => ({
        modelId: id,
        name: AGY_MODEL_LABELS[id]
    }))
}

// Reverse lookup: agy prints display names ("Gemini 3.5 Flash (Medium)") but
// `--model` wants ids ("gemini-3.5-flash-medium"). Known names map exactly via
// the hardcoded mirror; unknown (newly added) models fall back to deriveAgyId.
const NAME_TO_ID: Map<string, string> = new Map(
    (Object.entries(AGY_MODEL_LABELS) as Array<[string, string]>).map(([id, name]) => [name, id])
)

// Best-effort id from a display name, following agy's `<model>-<effort>`
// convention: lowercase, spaces→dashes, "(Variant)"→"-variant". Claude ids use
// dashes in the version (4.6→4-6); Gemini keeps the dot (3.5).
function deriveAgyId(name: string): string {
    let id = name.trim().toLowerCase()
    id = id.replace(/\s*\(([^)]+)\)\s*$/, '-$1')
    id = id.replace(/\s+/g, '-')
    if (id.startsWith('claude')) id = id.replace(/(\d)\.(\d)/g, '$1-$2')
    return id.replace(/-+/g, '-')
}

// agy's structured listing: one JSON object on stdout carrying the exact wire
// ids and display labels, so nothing has to be recovered from the human-facing
// table. Returns null when the output isn't that object — which is how older
// agy releases behave: they don't know `--output-format` and print the table
// instead of failing, so the caller falls through to the text parser.
function parseAgyModelsJson(output: string): AgyModelsResponse['availableModels'] | null {
    for (const line of output.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        let payload: unknown
        try {
            payload = JSON.parse(trimmed)
        } catch {
            continue
        }
        const entries = (payload as { command?: { data?: { models?: unknown } } })?.command?.data?.models
        if (!Array.isArray(entries)) continue
        const models: AgyModelsResponse['availableModels'] = []
        const seen = new Set<string>()
        for (const entry of entries) {
            const { id, label } = (entry ?? {}) as { id?: unknown; label?: unknown }
            if (typeof id !== 'string' || !id || seen.has(id)) continue
            seen.add(id)
            models.push(typeof label === 'string' && label ? { modelId: id, name: label } : { modelId: id })
        }
        if (models.length > 0) return models
    }
    return null
}

export const _parseAgyModelsJsonForTests = parseAgyModelsJson

// Parse `agy models` stdout into model entries, preserving agy's order. Returns
// null when no model lines are found (so the caller can fall back).
function parseAgyModelsOutput(output: string): AgyModelsResponse['availableModels'] | null {
    const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '\n')
    const models: AgyModelsResponse['availableModels'] = []
    const seen = new Set<string>()
    for (const raw of clean.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        // agy prints two columns: the exact wire id, then the display name. It
        // pads them into aligned columns when stdout is a TTY, and separates
        // them with a single tab when stdout is a pipe, which is the path this
        // probe takes. Require a tab or 2+ spaces, never a single space: a bare
        // `\s+` would also split status prose like "Fetching available
        // models..." into a fake model row. Never derive an id from the whole
        // row either: that produced ids such as `<id>-<id>`.
        const columns = line.match(/^([a-z0-9][a-z0-9._/-]*)(?:\t+| {2,})(.+)$/i)
        if (columns) {
            const modelId = columns[1]
            if (seen.has(modelId)) continue
            seen.add(modelId)
            models.push({ modelId, name: columns[2].trim() })
            continue
        }
        // Non-TTY output may contain only wire ids. Piped output takes this
        // branch for every model, so backfill the known display label — without
        // it the picker would show raw ids whenever the live probe succeeds.
        if (/^[a-z0-9][a-z0-9._/-]*$/i.test(line) && line.includes('-')) {
            if (seen.has(line)) continue
            seen.add(line)
            const label = AGY_MODEL_LABELS[line as keyof typeof AGY_MODEL_LABELS]
            models.push(label ? { modelId: line, name: label } : { modelId: line })
            continue
        }
        // Accept a known name verbatim, or anything shaped like "Name (Variant)".
        const isKnown = NAME_TO_ID.has(line)
        const looksLikeModel = /^[A-Za-z][\w.\-/ ]*\([^)]+\)$/.test(line)
        if (!isKnown && !looksLikeModel) continue
        const modelId = NAME_TO_ID.get(line) ?? deriveAgyId(line)
        if (seen.has(modelId)) continue
        seen.add(modelId)
        models.push({ modelId, name: line })
    }
    return models.length > 0 ? models : null
}

export const _parseAgyModelsOutputForTests = parseAgyModelsOutput

function checkOutputForAuthError(output: string): string | null {
    for (const pattern of AUTH_REQUIRED_PATTERNS) {
        if (output.includes(pattern)) {
            return 'Authentication required. Please run `agy` in a terminal to sign in with Google.'
        }
    }
    return null
}

// Build the env for the one-shot `agy models` probe. Auth must be as robust as
// the headless transport's, or the probe fails on hosts where the OS keyring is
// flaky or locked (headless runners):
//  - GEMINI_FORCE_FILE_STORAGE makes agy read the saved OAuth file token directly
//    instead of the keyring — the same hardening the headless spawn applies.
//    Without it the probe spins for ~12 s and exits with "Please sign in to view available
//    models" even when the user IS signed in, which surfaces as a failed fetch.
//  - SSH_* is stripped so agy doesn't fall into a degraded SSH-session auth path.
function buildAgyProbeEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_FORCE_FILE_STORAGE: 'true' }
    for (const key of Object.keys(env)) {
        if (key.startsWith('SSH_')) delete env[key]
    }
    return env
}

// `unreachable` covers the cases where agy never produced a listing at all
// (spawn failure, timeout) and there is nothing to read either way.
type AgyModelsProbe = { output: string } | { unreachable: true }

// Run one `agy` invocation and hand back everything it wrote. Both streams are
// joined because agy splits the listing (stdout) from its progress line
// (stderr), and the auth failure can surface on either.
function probeAgyModels(args: string[]): Promise<AgyModelsProbe> {
    return new Promise((resolve) => {
        const child = spawn(getAgentLaunchCommand('agy'), args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: buildAgyProbeEnv(),
            windowsHide: process.platform === 'win32',
        })
        let stdout = ''
        let stderr = ''
        let settled = false

        const timeout = setTimeout(() => {
            if (settled) return
            settled = true
            child.kill('SIGTERM')
            resolve({ unreachable: true })
        }, PROBE_TIMEOUT_MS)

        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
        })
        child.on('error', () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve({ unreachable: true })
        })
        child.on('exit', () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve({ output: stdout + stderr })
        })
    })
}

// Fetch the live model list from `agy models` (the agy CLI's own listing) so the
// picker always matches what agy currently offers — no redeploy when agy changes
// models. The hardcoded mirror is only a fallback (timeout / spawn error /
// unparseable output). An auth failure is surfaced so the UI can prompt sign-in.
async function fetchAgyCatalog(): Promise<AgyCatalogFetch> {
    // `--output-format` is a global flag: it has to come before the subcommand,
    // and agy only accepts the `=` form here. Releases that predate it ignore
    // the flag and print the table, which the text parser still understands.
    const probe = await probeAgyModels(['--output-format=json', 'models'])
    if ('unreachable' in probe) {
        return { kind: 'unavailable' }
    }

    const authError = checkOutputForAuthError(probe.output)
    if (authError) {
        return { kind: 'auth-error', error: authError }
    }

    // Prefer the structured listing, then the printed table for agy releases
    // that don't emit it, then the hardcoded mirror if neither could be read
    // (format change, partial fetch, etc.).
    const parsed = parseAgyModelsJson(probe.output) ?? parseAgyModelsOutput(probe.output)
    if (parsed) {
        return { kind: 'live', models: parsed }
    }

    // Nothing readable came back. Every agy release checked ignores an unknown
    // `--output-format` and prints the table anyway, but a build that rejected
    // it would emit no models at all and leave the picker on the mirror, so ask
    // once more without the flag before giving up on the live list. This only
    // costs a second invocation on builds that produced nothing usable.
    const retry = await probeAgyModels(['models'])
    if ('unreachable' in retry) {
        return { kind: 'unavailable' }
    }
    const retryAuthError = checkOutputForAuthError(retry.output)
    if (retryAuthError) {
        return { kind: 'auth-error', error: retryAuthError }
    }
    const retryParsed = parseAgyModelsOutput(retry.output)
    return retryParsed ? { kind: 'live', models: retryParsed } : { kind: 'unavailable' }
}

function startProbe(): Promise<AgyCatalogFetch> {
    const servedBefore = servedAnswerSignature()
    inflight = (async (): Promise<AgyCatalogFetch> => {
        try {
            const fetched = await fetchAgyCatalog()
            if (fetched.kind === 'live') {
                cachedCatalog = { models: fetched.models, fetchedAt: Date.now() }
                // agy answered, so whatever went wrong before is over.
                lastFailedProbe = null
            } else {
                lastFailedProbe = { at: Date.now(), result: fetched }
            }
            return fetched
        } catch {
            const result: AgyCatalogFetch = { kind: 'unavailable' }
            lastFailedProbe = { at: Date.now(), result }
            return result
        } finally {
            inflight = null
            // In the `finally` so a throw is compared the same way as a return.
            if (hasServedAnswer && servedAnswerSignature() !== servedBefore) {
                notifyCatalogChanged()
            }
        }
    })()

    return inflight
}

// Until the backoff lapses, asking again would only return what we already have.
function probeIsDue(): boolean {
    return lastFailedProbe === null || Date.now() - lastFailedProbe.at >= PROBE_BACKOFF_MS
}

async function refreshCatalog(force: boolean): Promise<AgyCatalogFetch> {
    // A probe already running when Retry was pressed predates whatever the user
    // just fixed in the terminal, so wait it out rather than answer from it.
    if (force && inflight) {
        await inflight.catch(() => { })
    }
    if (inflight) {
        return await inflight
    }
    if (!force && !probeIsDue() && lastFailedProbe) {
        return lastFailedProbe.result
    }

    return await startProbe()
}

// Servable and fresh are asked separately because the clock can step backwards
// (NTP, suspend/resume): an age we cannot trust is still the last thing agy told
// us, so it stays servable, but it must never count as fresh or nothing would
// revalidate it.
function cachedCatalogAge(): number {
    return cachedCatalog ? Date.now() - cachedCatalog.fetchedAt : Number.POSITIVE_INFINITY
}

function isCachedCatalogFresh(): boolean {
    const age = cachedCatalogAge()
    return age >= 0 && age < FRESH_TTL_MS
}

function servableCatalog(): ListAgyModelsResponse | null {
    if (!cachedCatalog || cachedCatalogAge() >= STALE_TTL_MS) {
        return null
    }


    const response: ListAgyModelsResponse = { success: true, availableModels: cachedCatalog.models }
    // A sign-in failure rides along with the listing: a picker that looked
    // healthy would let the user start a session agy cannot run.
    if (lastFailedProbe?.result.kind === 'auth-error') {
        response.error = lastFailedProbe.result.error
    }
    return response
}

function toResponse(fetched: AgyCatalogFetch): ListAgyModelsResponse {
    if (fetched.kind === 'live') {
        return { success: true, availableModels: fetched.models }
    }

    // A failed probe is not evidence that the catalog changed.
    const cached = servableCatalog()
    if (cached) {
        return cached
    }
    if (fetched.kind === 'auth-error') {
        return { success: false, error: fetched.error }
    }
    return { success: true, availableModels: buildModelList() }
}

// Built through toResponse so the announcement is keyed on the answer a plain
// read would get, not on the cache behind it. Without a servable catalog those
// two disagree: an uncached sign-in failure is an error response, while the
// cache still looks like the fallback listing.
function servedAnswerSignature(): string {
    return JSON.stringify(toResponse(lastFailedProbe?.result ?? { kind: 'unavailable' }))
}

export async function listAgyModels(options?: { refresh?: boolean }): Promise<ListAgyModelsResponse> {
    const answer = await answerAgyModels(options)
    // Set on the way out, not on entry: the first caller is awaiting the probe
    // rather than looking at a stale screen, so it needs no announcement.
    hasServedAnswer = true
    return answer
}

async function answerAgyModels(options?: { refresh?: boolean }): Promise<ListAgyModelsResponse> {
    // Retry is the user saying the cached answer is wrong, so it costs a probe.
    if (options?.refresh === true) {
        return toResponse(await refreshCatalog(true))
    }

    const cached = servableCatalog()
    if (cached) {
        // A warning is itself a reason to look again — the user may have signed
        // in since, and nothing else revalidates a catalog that is still fresh.
        if (!isCachedCatalogFresh() || lastFailedProbe) {
            void refreshCatalog(false).catch(() => { })
        }
        return cached
    }

    return toResponse(await refreshCatalog(false))
}

export function _resetAgyModelsCacheForTests(): void {
    cachedCatalog = null
    lastFailedProbe = null
    inflight = null
    hasServedAnswer = false
    catalogChangeListener = null
}
