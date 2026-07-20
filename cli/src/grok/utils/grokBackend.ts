import { AcpSdkBackend } from '@/agent/backends/acp'
import { assertSafeWindowsShellArg } from './windowsShellArgs'

const ANSI_SGR_PATTERN = /\u001b\[[0-9;]*m/g

function stripAnsi(value: string): string {
    return value.replace(ANSI_SGR_PATTERN, '')
}

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value
        }
    }
    return result
}

export function buildGrokAgentArgs(opts: { cwd: string; model?: string; effort?: string }): string[] {
    assertSafeWindowsShellArg(opts.cwd, 'cwd')
    if (opts.model) assertSafeWindowsShellArg(opts.model, 'model')
    if (opts.effort) assertSafeWindowsShellArg(opts.effort, 'effort')

    // --cwd is a top-level Grok flag and must precede the `agent` subcommand.
    // session/new also carries cwd, but setting it at process start ensures
    // Grok discovers the correct project rules/plugins before initialization.
    const args = ['--cwd', opts.cwd, 'agent']
    if (opts.model) {
        args.push('--model', opts.model)
    }
    if (opts.effort) {
        args.push('--reasoning-effort', opts.effort)
    }
    args.push('stdio')
    return args
}

export function createGrokBackend(opts: {
    cwd: string
    model?: string
    effort?: string
}): AcpSdkBackend {
    return new AcpSdkBackend({
        command: 'grok',
        args: buildGrokAgentArgs(opts),
        env: filterEnv(process.env)
    })
}

export function formatGrokError(error: unknown): string {
    const message = stripAnsi(error instanceof Error ? error.message : String(error))
    if (/authentication required|no auth method id provided/i.test(message)) {
        return 'Grok authentication required. Run `grok login --device-auth` on this machine, or configure XAI_API_KEY.'
    }
    return message
}

/**
 * Grok 0.2.93 generates a session title through its separate
 * GROK_SESSION_SUMMARY_MODEL route. Accounts whose catalog only exposes
 * grok-4.5 can receive a non-fatal 402 for that default grok-build request
 * while the selected grok-4.5 turn continues normally. The prompt rejection,
 * if any, is reported separately by backend.prompt(), so suppressing this
 * auxiliary stderr line cannot hide a failed main turn.
 */
export function isGrokBuildAuxiliaryQuotaError(
    value: string,
    activeModel: string | null | undefined
): boolean {
    if (!activeModel || activeModel === 'grok-build') return false
    const message = stripAnsi(value)
    return /(?:status\s*=\s*)?402\s+Payment Required/i.test(message)
        && /model_id\s*=\s*grok-build\b/i.test(message)
        && /(?:spending-limit|run out of credits|need a Grok subscription)/i.test(message)
}
