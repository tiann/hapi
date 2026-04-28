import spawn from 'cross-spawn'
import { withBunRuntimeEnv } from '@/utils/bunRuntime'

export const MIN_CODEX_HOOKS_VERSION = '0.124.0'

const SEMVER_PATTERN = /\b(\d+)\.(\d+)\.(\d+)\b/

function parseVersionTuple(value: string): [number, number, number] | null {
    const match = value.match(SEMVER_PATTERN)
    if (!match) {
        return null
    }

    return [
        Number.parseInt(match[1], 10),
        Number.parseInt(match[2], 10),
        Number.parseInt(match[3], 10)
    ]
}

function getLocalModeRequirementMessage(): string {
    return `Codex CLI ${MIN_CODEX_HOOKS_VERSION}+ is required for hapi codex local mode because HAPI depends on stable hooks.`
}

export function parseCodexVersion(output: string): string | null {
    const tuple = parseVersionTuple(output)
    if (!tuple) {
        return null
    }

    return tuple.join('.')
}

export function isCodexVersionAtLeast(version: string, minimum: string): boolean {
    const versionTuple = parseVersionTuple(version)
    const minimumTuple = parseVersionTuple(minimum)

    if (!versionTuple || !minimumTuple) {
        throw new Error('Invalid semver value')
    }

    for (let i = 0; i < versionTuple.length; i++) {
        if (versionTuple[i] > minimumTuple[i]) {
            return true
        }
        if (versionTuple[i] < minimumTuple[i]) {
            return false
        }
    }

    return true
}

export function assertCodexLocalSupported(): void {
    let output: string

    const result = spawn.sync('codex', ['--version'], {
        encoding: 'utf8',
        env: withBunRuntimeEnv()
    })

    if (result.error) {
        const maybeError = result.error as NodeJS.ErrnoException
        const message = maybeError?.message ? ` ${maybeError.message}` : ''

        if (maybeError?.code === 'ENOENT') {
            throw new Error(
                `${getLocalModeRequirementMessage()} Codex was not found on PATH. Please install or upgrade Codex and retry.`,
                { cause: result.error }
            )
        }

        throw new Error(
            `Could not determine Codex CLI version.${message} ` +
            `${getLocalModeRequirementMessage()} Please upgrade Codex and retry.`,
            { cause: result.error }
        )
    }

    if (result.status !== 0) {
        const detail = result.stderr ? ` ${result.stderr.trim()}` : ''
        throw new Error(
            `Could not determine Codex CLI version.${detail} ` +
            `${getLocalModeRequirementMessage()} Please upgrade Codex and retry.`
        )
    }

    output = result.stdout.trim()

    const version = parseCodexVersion(output)
    if (!version) {
        throw new Error(
            `Could not determine Codex CLI version. ${getLocalModeRequirementMessage()} Please upgrade Codex and retry.`
        )
    }

    if (!isCodexVersionAtLeast(version, MIN_CODEX_HOOKS_VERSION)) {
        throw new Error(
            `${getLocalModeRequirementMessage()} Detected: ${version}. Please upgrade Codex and retry.`
        )
    }
}
