import { spawn } from 'node:child_process'
import { asString, isObject } from '@hapi/protocol'
import type { GrokModelSummary, GrokModelsResponse, GrokReasoningEffortOption } from '@hapi/protocol/apiTypes'
import { AcpStdioTransport } from '@/agent/backends/acp/AcpStdioTransport'
import { assertSafeWindowsShellArg } from '@/grok/utils/windowsShellArgs'
import { getErrorMessage } from './rpcResponses'
import packageJson from '../../../package.json'

export interface ListGrokModelsForCwdRequest {
    cwd?: string
}

export type ListGrokModelsForCwdResponse = GrokModelsResponse

interface CacheEntry {
    expiresAt: number
    response: ListGrokModelsForCwdResponse
}

const CACHE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 15_000
const SETTINGS_PROBE_GRACE_MS = 300
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ListGrokModelsForCwdResponse>>()

export function buildGrokModelsArgs(cwd: string): string[] {
    assertSafeWindowsShellArg(cwd, 'cwd')
    return ['--cwd', cwd, 'models']
}

export function parseGrokModelsOutput(output: string): {
    availableModels: GrokModelSummary[]
    currentModelId: string | null
} {
    const availableModels: GrokModelSummary[] = []
    const seen = new Set<string>()
    let currentModelId: string | null = null
    let inAvailableModels = false

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (line.startsWith('Default model:')) {
            currentModelId = line.slice('Default model:'.length).trim() || null
            continue
        }
        if (line === 'Available models:') {
            inAvailableModels = true
            continue
        }
        if (!inAvailableModels || !line.startsWith('*')) continue

        const modelId = line.slice(1).replace(/\s+\(default\)\s*$/, '').trim()
        if (!modelId || seen.has(modelId)) continue
        seen.add(modelId)
        availableModels.push({ modelId })
    }

    if (currentModelId && !seen.has(currentModelId)) {
        availableModels.unshift({ modelId: currentModelId })
    }

    return { availableModels, currentModelId }
}

export function parseGrokInitializeModels(response: unknown): {
    availableModels: GrokModelSummary[]
    currentModelId: string | null
    autoPermissionModeSupported: boolean
} {
    if (!isObject(response) || !isObject(response._meta) || !isObject(response._meta.modelState)) {
        return { availableModels: [], currentModelId: null, autoPermissionModeSupported: false }
    }
    const state = response._meta.modelState
    const rawCommands = Array.isArray(response._meta.availableCommands)
        ? response._meta.availableCommands
        : []
    const autoPermissionModeSupported = rawCommands.some(
        (entry) => isObject(entry) && asString(entry.name) === 'auto'
    )
    const currentModelId = asString(state.currentModelId)
    const rawModels = Array.isArray(state.availableModels) ? state.availableModels : []
    const availableModels = rawModels
        .filter((entry): entry is Record<string, unknown> => isObject(entry))
        .map((entry): GrokModelSummary | null => {
            const modelId = asString(entry.modelId)
            if (!modelId) return null
            const meta = isObject(entry._meta) ? entry._meta : null
            const rawEfforts = meta && Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : []
            const reasoningEfforts = rawEfforts
                .filter((effort): effort is Record<string, unknown> => isObject(effort))
                .map((effort): GrokReasoningEffortOption => ({
                    value: asString(effort.value) ?? asString(effort.id) ?? '',
                    name: asString(effort.label) ?? undefined,
                    isDefault: effort.default === true
                }))
                .filter((effort) => effort.value.length > 0)
            return {
                modelId,
                name: asString(entry.name) ?? undefined,
                ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {})
            }
        })
        .filter((entry): entry is GrokModelSummary => entry !== null)

    return { availableModels, currentModelId, autoPermissionModeSupported }
}

async function runGrokModelsCliProbe(cwd: string): Promise<ListGrokModelsForCwdResponse> {
    return await new Promise((resolve, reject) => {
        const child = spawn('grok', buildGrokModelsArgs(cwd), {
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            windowsHide: process.platform === 'win32'
        })
        let stdout = ''
        let stderr = ''
        let settled = false

        const timeout = setTimeout(() => {
            if (settled) return
            settled = true
            child.kill('SIGTERM')
            reject(new Error('Grok model discovery timed out'))
        }, PROBE_TIMEOUT_MS)

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString()
        })
        child.on('error', (error) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            reject(error)
        })
        child.on('exit', (code) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            if (code !== 0) {
                reject(new Error(stderr.trim() || `grok models exited with code ${code}`))
                return
            }
            resolve({ success: true, ...parseGrokModelsOutput(stdout) })
        })
    })
}

async function runGrokModelsProbe(cwd: string): Promise<ListGrokModelsForCwdResponse> {
    // The primary ACP probe also uses shell mode on Windows through AcpStdioTransport.
    assertSafeWindowsShellArg(cwd, 'cwd')
    const transport = new AcpStdioTransport({
        command: 'grok',
        args: ['--cwd', cwd, 'agent', '--reasoning-effort', 'low', 'stdio'],
        env: Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
        )
    })
    try {
        let resolveAutoPermissionMode: ((supported: boolean) => void) | null = null
        const autoPermissionMode = new Promise<boolean>((resolve) => {
            resolveAutoPermissionMode = resolve
        })
        transport.onNotification((method, params) => {
            if (
                method === '_x.ai/settings/update'
                && isObject(params)
                && 'auto_permission_mode_enabled' in params
            ) {
                resolveAutoPermissionMode?.(params.auto_permission_mode_enabled === true)
                resolveAutoPermissionMode = null
            }
        })
        const response = await transport.sendRequest('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
                _meta: { parameterizedModelPicker: true }
            },
            clientInfo: { name: 'hapi-grok-models', version: packageJson.version }
        }, { timeoutMs: PROBE_TIMEOUT_MS })
        const parsed = parseGrokInitializeModels(response)
        if (parsed.availableModels.length > 0) {
            const remoteSupport = await Promise.race([
                autoPermissionMode,
                new Promise<null>((resolve) => setTimeout(resolve, SETTINGS_PROBE_GRACE_MS, null))
            ])
            return {
                success: true,
                ...parsed,
                autoPermissionModeSupported: parsed.autoPermissionModeSupported || remoteSupport === true
            }
        }
    } catch {
        // Older Grok builds may not expose modelState during initialize.
        // Fall back to the stable `grok models` command below.
    } finally {
        await transport.close().catch(() => undefined)
    }
    return await runGrokModelsCliProbe(cwd)
}

export async function listGrokModelsForCwd(cwd: string): Promise<ListGrokModelsForCwdResponse> {
    const trimmed = cwd?.trim()
    if (!trimmed) return { success: false, error: 'cwd is required' }

    const cached = cache.get(trimmed)
    if (cached && cached.expiresAt > Date.now()) return cached.response

    const running = inflight.get(trimmed)
    if (running) return running

    const promise = (async () => {
        try {
            const response = await runGrokModelsProbe(trimmed)
            if (response.success) {
                cache.set(trimmed, { expiresAt: Date.now() + CACHE_TTL_MS, response })
            }
            return response
        } catch (error) {
            return {
                success: false,
                error: getErrorMessage(error, 'Failed to discover Grok models')
            }
        } finally {
            inflight.delete(trimmed)
        }
    })()

    inflight.set(trimmed, promise)
    return promise
}

export function _resetGrokModelsCacheForTests(): void {
    cache.clear()
    inflight.clear()
}
