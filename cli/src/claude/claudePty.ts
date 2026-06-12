import { runAgentPty } from "@/agent/runAgentPty"
import { cleanupTrustedConfigDir, prepareTrustedConfigDir } from "@/claude/trustedConfigDir"

export type ClaudePtyOpts = {
    sessionId: string | null
    path: string
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    /**
     * Path to a Claude settings file registering a SessionStart hook. When
     * present, `--settings <path>` is appended so the interactive (PTY) Claude
     * reports its freshly created sessionId back to Hapi, enabling the session
     * scanner to tail the matching jsonl transcript for structured messages.
     */
    hookSettingsPath?: string
    signal?: AbortSignal
    nextMessage: () => Promise<{ message: string } | null>
    onReady: () => void
    onMessage: (data: string) => void
    /** Fired after the driver has written a message to the PTY. See runAgentPty. */
    onMessageSubmitted?: (message: string) => void | Promise<void>
    onThinkingChange?: (thinking: boolean) => void
    onExit?: (code: number | null) => void
    registerControls?: (controls: { resize: (cols: number, rows: number) => void; sendKeys: (data: string) => void }) => void
}

function buildClaudePtyArgs(opts: ClaudePtyOpts): string[] {
    const args: string[] = []
    if (opts.hookSettingsPath) {
        args.push('--settings', opts.hookSettingsPath)
    }
    if (opts.claudeArgs) {
        args.push(...opts.claudeArgs)
    }
    return args
}

// claude's ink TUI renders these strings once the input prompt is ready.
// NOTE: '❯' is intentionally excluded — it also appears in the first-run trust
// prompt ("❯ 1. Yes, I trust this folder"), so using it as a prompt marker
// would make the trust screen look like the input prompt.
const CLAUDE_PROMPT_MARKERS = ['for shortcuts', 'bypass permissions', 'esc to interrupt']
// First-run trust/safety prompt. Primary suppression is an isolated
// CLAUDE_CONFIG_DIR with the folder pre-trusted (see prepareTrustedConfigDir);
// these markers are a fallback so the driver auto-approves (Enter = Yes) if the
// prompt still appears. We deliberately do NOT touch the user's ~/.claude.json.
const CLAUDE_TRUST_MARKERS = ['trust this folder', 'Yes, I trust', 'safety check']
// Footer shown while generating ("… (esc to interrupt)") vs at an idle input
// prompt ("? for shortcuts"). Drives the chat thinking indicator.
const CLAUDE_BUSY_MARKERS = ['esc to interrupt']
const CLAUDE_IDLE_MARKERS = ['for shortcuts']

// When claude is launched from a process that itself inherited Claude Code's env
// (e.g. the runner started from inside a Claude session, a hook, or a sub-agent),
// the child claude sees CLAUDECODE / CLAUDE_CODE_* and treats itself as a nested
// session — and STOPS WRITING ITS JSONL TRANSCRIPT (so HAPI's scanner has nothing
// to forward to chat). Strip these markers so the spawned claude is a clean,
// top-level session that persists its transcript. (Note: CLAUDE_CONFIG_DIR is
// NOT matched and is preserved.)
function claudeInheritedEnvKeys(): string[] {
    return Object.keys(process.env).filter(
        (k) => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')
    )
}

export async function claudePty(opts: ClaudePtyOpts): Promise<void> {
    // Pre-trust the folder in a throwaway config dir so the trust prompt never
    // shows — without mutating the user's real ~/.claude.json.
    const configDir = prepareTrustedConfigDir(opts.path)
    try {
        return await runAgentPty({
            command: 'claude',
            args: buildClaudePtyArgs(opts),
            cwd: opts.path,
            envVars: opts.claudeEnvVars,
            extraEnv: {
                DISABLE_AUTOUPDATER: '1',
                ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
            },
            // Drop inherited CLAUDECODE / CLAUDE_CODE_* so claude saves its
            // transcript (see claudeInheritedEnvKeys).
            unsetEnv: claudeInheritedEnvKeys(),
            promptMarkers: CLAUDE_PROMPT_MARKERS,
            trustMarkers: CLAUDE_TRUST_MARKERS,
            busyMarkers: CLAUDE_BUSY_MARKERS,
            idleMarkers: CLAUDE_IDLE_MARKERS,
            debugPrefix: '[claudePty]',
            signal: opts.signal,
            nextMessage: opts.nextMessage,
            onReady: opts.onReady,
            onMessage: opts.onMessage,
            onMessageSubmitted: opts.onMessageSubmitted,
            onThinkingChange: opts.onThinkingChange,
            onExit: opts.onExit,
            registerControls: opts.registerControls,
        })
    } finally {
        cleanupTrustedConfigDir(configDir)
    }
}
