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

interface CacheEntry {
    expiresAt: number
    response: ListAgyModelsResponse
}

const CACHE_TTL_MS = 60_000
const cache: CacheEntry = {
    expiresAt: 0,
    response: { success: true, availableModels: [] }
}
let inflight: Promise<ListAgyModelsResponse> | null = null

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
async function fetchAgyModels(): Promise<ListAgyModelsResponse> {
    // `--output-format` is a global flag: it has to come before the subcommand,
    // and agy only accepts the `=` form here. Releases that predate it ignore
    // the flag and print the table, which the text parser still understands.
    const probe = await probeAgyModels(['--output-format=json', 'models'])
    if ('unreachable' in probe) {
        return { success: true, availableModels: buildModelList() }
    }

    const authError = checkOutputForAuthError(probe.output)
    if (authError) {
        return { success: false, error: authError }
    }

    // Prefer the structured listing, then the printed table for agy releases
    // that don't emit it, then the hardcoded mirror if neither could be read
    // (format change, partial fetch, etc.).
    const parsed = parseAgyModelsJson(probe.output) ?? parseAgyModelsOutput(probe.output)
    if (parsed) {
        return { success: true, availableModels: parsed }
    }

    // Nothing readable came back. Every agy release checked ignores an unknown
    // `--output-format` and prints the table anyway, but a build that rejected
    // it would emit no models at all and leave the picker on the mirror, so ask
    // once more without the flag before giving up on the live list. This only
    // costs a second invocation on builds that produced nothing usable.
    const retry = await probeAgyModels(['models'])
    if ('unreachable' in retry) {
        return { success: true, availableModels: buildModelList() }
    }
    const retryAuthError = checkOutputForAuthError(retry.output)
    if (retryAuthError) {
        return { success: false, error: retryAuthError }
    }
    return { success: true, availableModels: parseAgyModelsOutput(retry.output) ?? buildModelList() }
}

export async function listAgyModels(): Promise<ListAgyModelsResponse> {
    if (cache.expiresAt > Date.now() && (cache.response.availableModels?.length ?? 0) > 0) {
        return cache.response
    }

    if (inflight) {
        return inflight
    }

    inflight = (async () => {
        try {
            const response = await fetchAgyModels()
            if (response.success && (response.availableModels?.length ?? 0) > 0) {
                cache.expiresAt = Date.now() + CACHE_TTL_MS
                cache.response = response
            }
            return response
        } catch {
            return { success: true, availableModels: buildModelList() }
        } finally {
            inflight = null
        }
    })()

    return inflight
}

export function _resetAgyModelsCacheForTests(): void {
    cache.expiresAt = 0
    cache.response = { success: true, availableModels: [] }
    inflight = null
}
