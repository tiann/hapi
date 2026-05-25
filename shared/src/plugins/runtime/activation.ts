import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DiscoveredPluginRecord } from '../foundation'
import type { PluginRuntimeName } from '../manifest'
import type { RuntimeActivationResult, RuntimeReloadActiveInstance } from './reloadController'
import { errorMessage } from './diagnostics'
import { redactText } from './registryBase'

export type ActivatablePluginModule = {
    activate?: unknown
    default?: unknown
} | null | undefined

export function getActivate<TActivate>(value: unknown): TActivate | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    const moduleObject = value as ActivatablePluginModule
    if (typeof moduleObject?.activate === 'function') {
        return moduleObject.activate as TActivate
    }
    if (typeof moduleObject?.default === 'function') {
        return moduleObject.default as TActivate
    }
    if (moduleObject?.default && typeof moduleObject.default === 'object') {
        const defaultObject = moduleObject.default as { activate?: unknown }
        if (typeof defaultObject.activate === 'function') {
            return defaultObject.activate as TActivate
        }
    }
    return null
}

export function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
    }
    if (value && typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
            .join(',')}}`
    }
    return JSON.stringify(value)
}

export async function safeMtime(path: string): Promise<number> {
    try {
        return (await stat(path)).mtimeMs
    } catch {
        return 0
    }
}

export type ReloadImportPathStrategy = 'hidden-sibling' | 'entry-suffix'
const DEFAULT_RUNTIME_ACTIVATION_TIMEOUT_MS = 5000

function withActivationTimeout<T>(work: Promise<T> | T, timeoutMs: number, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | null = null
    return Promise.race([
        Promise.resolve(work),
        new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        })
    ]).finally(() => {
        if (timeout) clearTimeout(timeout)
    })
}

export async function materializeReloadImportPath(args: {
    realPath: string
    pluginId: string
    signature: string
    marker: string
    strategy?: ReloadImportPathStrategy
}): Promise<string> {
    const hash = createHash('sha256').update(args.signature).digest('hex').slice(0, 16)
    const safePluginId = args.pluginId.replace(/[^A-Za-z0-9._-]/g, '_')
    const strategy = args.strategy ?? 'hidden-sibling'
    const shadowPath = strategy === 'entry-suffix'
        ? materializedEntrySuffixPath(args.realPath, args.marker, safePluginId, hash)
        : join(dirname(args.realPath), `.${args.marker}-${safePluginId}-${hash}.mjs`)
    await mkdir(dirname(shadowPath), { recursive: true })
    await writeFile(shadowPath, await readFile(args.realPath, 'utf8'))
    return shadowPath
}

function materializedEntrySuffixPath(realPath: string, marker: string, safePluginId: string, hash: string): string {
    const dir = dirname(realPath)
    const file = basename(realPath)
    const extension = extname(file)
    const stem = extension ? file.slice(0, -extension.length) : file
    return join(dir, `${stem}.${marker}-${safePluginId}-${hash}.mjs`)
}

export type RuntimePluginActivate<TContext> = (ctx: TContext) => void | Promise<void>

export type RuntimeActivationRegistry<TContext> = {
    getDisposableCount(): number
    createContext(args: {
        pluginId: string
        config?: Record<string, unknown>
        declaredSecrets?: string[]
        declaredNetwork?: string[]
        env?: NodeJS.ProcessEnv
    }): { ctx: TContext; close(): void }
    disposeFrom(startIndex: number): Promise<void>
    dispose(): Promise<void>
}

export async function activateRuntimeRecord<
    TContext,
    TRegistry extends RuntimeActivationRegistry<TContext>,
    TInstance extends RuntimeReloadActiveInstance
>(options: {
    record: DiscoveredPluginRecord
    signature: string
    runtime: Extract<PluginRuntimeName, 'hub' | 'runner'>
    runtimeDisplayName: 'Hub' | 'Runner'
    missingEntryCode: string
    invalidEntryCode: string
    activationFailedCode: string
    activationFailureLabel: string
    importQueryName: string
    reloadMarker: string
    reloadStrategy?: ReloadImportPathStrategy
    activationTimeoutMs?: number
    env?: NodeJS.ProcessEnv
    createRegistry(): TRegistry
    createInstance(args: {
        pluginId: string
        registry: TRegistry
        record: DiscoveredPluginRecord
        signature: string
        loadedAt: number
    }): TInstance
}): Promise<RuntimeActivationResult<TInstance>> {
    const pluginId = options.record.manifest!.id
    const runtimeEntry = options.record.runtimeEntryPaths.find((entry) => entry.runtime === options.runtime)
    if (!runtimeEntry) {
        const message = `${options.runtimeDisplayName} runtime entry is missing.`
        return {
            ok: false,
            message,
            diagnostics: [{
                pluginId,
                severity: 'error',
                code: options.missingEntryCode,
                message,
                path: options.record.manifestPath
            }]
        }
    }

    const declaredSecrets = options.record.manifest?.permissions?.secrets ?? []
    const declaredNetwork = options.record.manifest?.permissions?.network ?? []
    const activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_RUNTIME_ACTIVATION_TIMEOUT_MS
    const registry = options.createRegistry()
    try {
        const importPath = await materializeReloadImportPath({
            realPath: runtimeEntry.realPath,
            pluginId,
            signature: options.signature,
            marker: options.reloadMarker,
            strategy: options.reloadStrategy
        })
        const importUrl = `${pathToFileURL(importPath).href}?${options.importQueryName}=${encodeURIComponent(pluginId)}&signature=${encodeURIComponent(options.signature)}`
        const importedModule = await withActivationTimeout(import(importUrl), activationTimeoutMs, `${options.runtimeDisplayName} plugin import ${pluginId}`)
        const activate = getActivate<RuntimePluginActivate<TContext>>(importedModule)
        if (!activate) {
            const message = `${options.runtimeDisplayName} runtime entry must export activate(ctx).`
            return {
                ok: false,
                message,
                diagnostics: [{
                    pluginId,
                    severity: 'error',
                    code: options.invalidEntryCode,
                    message,
                    path: options.record.manifestPath
                }]
            }
        }

        const disposableStart = registry.getDisposableCount()
        const activation = registry.createContext({
            pluginId,
            config: options.record.config,
            declaredSecrets,
            declaredNetwork,
            env: options.env
        })
        try {
            await withActivationTimeout(activate(activation.ctx), activationTimeoutMs, `${options.runtimeDisplayName} plugin activate ${pluginId}`)
            activation.close()
        } catch (error) {
            activation.close()
            await registry.disposeFrom(disposableStart)
            throw error
        }

        return {
            ok: true,
            instance: options.createInstance({
                pluginId,
                registry,
                record: options.record,
                signature: options.signature,
                loadedAt: Date.now()
            })
        }
    } catch (error) {
        await registry.dispose().catch(() => undefined)
        const message = redactText(`Failed to import or activate ${options.activationFailureLabel}: ${errorMessage(error)}`, declaredSecrets, options.env)
        return {
            ok: false,
            message,
            diagnostics: [{
                pluginId,
                severity: 'error',
                code: options.activationFailedCode,
                message,
                path: options.record.manifestPath
            }]
        }
    }
}
