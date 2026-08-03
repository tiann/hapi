import { spawn } from 'node:child_process'
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

// Parse `agy models` stdout into model entries, preserving agy's order. Returns
// null when no model lines are found (so the caller can fall back).
function parseAgyModelsOutput(output: string): AgyModelsResponse['availableModels'] | null {
    const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '\n')
    const models: AgyModelsResponse['availableModels'] = []
    const seen = new Set<string>()
    for (const raw of clean.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        // agy 1.1.5 prints two columns: the exact wire id, then the display
        // name separated by two or more spaces. Never derive an id from the
        // whole row: that produced ids such as `<id>-<id>`.
        const columns = line.match(/^([a-z0-9][a-z0-9._/-]*)\s{2,}(.+)$/i)
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
// the PTY launch's, or the probe fails on hosts where the OS keyring is flaky or
// locked (headless runners):
//  - GEMINI_FORCE_FILE_STORAGE makes agy read the saved OAuth file token directly
//    instead of the keyring — the same hardening agyPty applies. Without it the
//    probe spins for ~12 s and exits with "Please sign in to view available
//    models" even when the user IS signed in, which surfaces as a failed fetch.
//  - SSH_* is stripped so agy doesn't fall into a degraded SSH-session auth path.
function buildAgyProbeEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_FORCE_FILE_STORAGE: 'true' }
    for (const key of Object.keys(env)) {
        if (key.startsWith('SSH_')) delete env[key]
    }
    return env
}

// Fetch the live model list from `agy models` (the agy CLI's own listing) so the
// picker always matches what agy currently offers — no redeploy when agy changes
// models. The hardcoded mirror is only a fallback (timeout / spawn error /
// unparseable output). An auth failure is surfaced so the UI can prompt sign-in.
async function fetchAgyModels(): Promise<ListAgyModelsResponse> {
    return await new Promise((resolve) => {
        const child = spawn('agy', ['models'], {
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
            resolve({ success: true, availableModels: buildModelList() })
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
            resolve({ success: true, availableModels: buildModelList() })
        })
        child.on('exit', () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)

            const output = stdout + stderr
            const authError = checkOutputForAuthError(output)
            if (authError) {
                resolve({ success: false, error: authError })
                return
            }

            // Prefer the live list; fall back to the hardcoded mirror if the
            // output couldn't be parsed (format change, partial fetch, etc.).
            const parsed = parseAgyModelsOutput(output)
            resolve({ success: true, availableModels: parsed ?? buildModelList() })
        })
    })
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
