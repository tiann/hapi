import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isBunCompiled, projectPath } from '@/projectPath'
import { resolveHappyCliExecutable } from '@/utils/spawnHappyCLI'

export type WrapperRuntime = { runtime: 'rust'; bin: string } | { runtime: 'ts'; reason: string }

/**
 * Agent flavors whose Rust session wrapper exists in this tree.
 * Empty until a flavor wrapper lands (e.g. `claude`, then `codex`).
 */
export const SUPPORTED_RUST_WRAPPER_FLAVORS: readonly string[] = []

const binaryName = 'hapi-session-wrapper'

function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK)
        return statSync(path).isFile()
    } catch {
        return false
    }
}

export function resolveRustExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
    const override = env.HAPI_RUST_WRAPPER_BIN?.trim()
    if (override && isAbsolute(override) && basename(override) === binaryName && isExecutable(override)) {
        return override
    }
    try {
        const sibling = join(dirname(realpathSync(resolveHappyCliExecutable())), binaryName)
        if (isExecutable(sibling)) return sibling
    } catch {}
    if (!isBunCompiled()) {
        const release = join(projectPath(), '..', 'target', 'release', binaryName)
        if (isExecutable(release)) return release
    }
    return null
}

export function resolveWrapperRuntime(
    agent: string,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    startingMode?: string,
    supportedFlavors: readonly string[] = SUPPORTED_RUST_WRAPPER_FLAVORS,
): WrapperRuntime {
    const normalizedAgent = agent.trim().toLowerCase()
    const flavors = env.HAPI_RUST_WRAPPER_FLAVORS
        ?.toLowerCase()
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
    if (!normalizedAgent || !flavors?.includes(normalizedAgent) || flavors.includes('none')) {
        return { runtime: 'ts', reason: 'flavor disabled' }
    }
    if (platform !== 'linux') return { runtime: 'ts', reason: 'unsupported platform' }
    if (startingMode === 'local') return { runtime: 'ts', reason: 'local mode' }
    if (!supportedFlavors.includes(normalizedAgent)) return { runtime: 'ts', reason: 'unsupported flavor' }
    const bin = resolveRustExecutable(env)
    return bin ? { runtime: 'rust', bin } : { runtime: 'ts', reason: 'binary unavailable' }
}
