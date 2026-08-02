import { runAgentPty } from "@/agent/runAgentPty"

export type AgyPtyOpts = {
    sessionId: string | null
    path: string
    agyEnvVars?: Record<string, string>
    agyArgs?: string[]
    /**
     * When set, the agy PTY is launched with `--conversation <uuid>` to resume
     * the existing brain session. Corresponds to `agy --conversation <ID>`.
     */
    resumeSessionId?: string
    /**
     * Model id to launch agy with (`agy --model <id>`, e.g.
     * `gemini-3.5-flash-medium`). When unset, agy uses its own default.
     */
    model?: string
    signal?: AbortSignal
    nextMessage: () => Promise<{ message: string } | null>
    onReady: () => void
    onMessage: (data: string) => void
    onThinkingChange?: (thinking: boolean) => void
    onExit?: (code: number | null) => void
    onAuthFailure?: () => void
    registerControls?: (controls: { resize: (cols: number, rows: number) => void; sendKeys: (data: string) => void }) => void
    /**
     * Additional workspace containing HAPI's .agents/hooks.json. The actual
     * project cwd and the user's HOME remain unchanged.
     */
    hookCarrierDir?: string
    hookPort?: number
    hookToken?: string
}

export function buildAgyPtyArgs(opts: AgyPtyOpts): string[] {
    const args: string[] = []
    if (opts.agyArgs) {
        args.push(...opts.agyArgs)
    }
    if (opts.hookCarrierDir) {
        args.push('--add-dir', opts.hookCarrierDir)
    }
    // Resume an existing agy conversation by brain UUID.
    if (opts.resumeSessionId) {
        args.push('--conversation', opts.resumeSessionId)
    }
    if (opts.model) {
        args.push('--model', opts.model)
    }
    return args
}

// agy no longer shows the "? for shortcuts" hint text that earlier versions
// rendered at the idle prompt. The reliable signal that auth has completed and
// the TUI is ready is the signed-in startup banner it always prints:
//   "▄▀▀▄        Antigravity CLI 1.1.0"
// Match the version generically (`Antigravity CLI <digit>`) rather than a
// hard-coded version: the banner carries whatever agy version is installed, so
// pinning "1.0"/"1.1" silently breaks readiness detection on the next agy
// upgrade — a stale "1.0" pin stopped matching once agy shipped 1.1.0, which is
// exactly the regression this guards against. The `\d` also keeps this from
// matching the transient pre-auth "Welcome to the Antigravity CLI. You are
// currently not signed in." line (no digit after "CLI"), so HAPI doesn't send
// the first message during the "Signing in…" handshake (keystrokes are silently
// dropped there). AGY_IDLE_READY_MS gives the TUI time to finish painting.
export const AGY_PROMPT_MARKERS: (string | RegExp)[] = [/Antigravity CLI \d/]

// agy shows a first-run folder-trust prompt in a directory it hasn't seen
// before ("Do you trust the contents of this project?", default highlight
// "Yes, I trust this folder"). This is separate from
// --dangerously-skip-permissions (which only auto-approves TOOL calls, not
// folder trust), so without handling it agy blocks at the trust dialog forever
// in any untrusted cwd (a fresh worktree, a new project dir): the session never
// reaches its prompt, the spawn's ready-wait never resolves, and the web shows
// a create failure while the session lingers in the background. runAgentPty
// auto-approves the prompt with Enter (default highlight = Yes) when this marker
// appears, before prompt detection, so the trust screen isn't mistaken for the
// input prompt and the first user message isn't consumed by it.
export const AGY_TRUST_MARKERS = ['Do you trust the contents']

// The REAL auth-failure signal: agy drops to this interactive login menu
// only when keyring auth actually fails (hardcoded 5 s keyring timeout).
//
// REMOVED: 'not signed in' — agy transiently shows
//   "You are currently not signed in. ⣷ Signing in..."
// on EVERY startup while the keyring auth handshake is in flight. This banner
// disappears once auth succeeds, so matching it before the login menu was
// settled caused false-positive re-spawns even when authentication succeeded.
export const AGY_AUTH_FAILURE_MARKERS = ['Select login method']

// agy 1.0.8 has no idle hint text at the input prompt (the "? for shortcuts"
// footer was removed). Idle markers are empty; thinking state for agy is
// driven solely by message-submit (setThinking(true)) and the silence watchdog.
export const AGY_IDLE_MARKERS: string[] = []

// agy animates a "Generating..." spinner continuously while it works — it does
// NOT sit silent mid-turn. This busy marker flags thinking=true AND, crucially,
// enables runAgentPty's output-silence watchdog (gated on hasBusyMarkers): once
// the turn ends and the spinner stops repainting, the watchdog clears the
// thinking state. Without it the optimistic post-submit setThinking(true) would
// never clear and the chat would sit "busy" forever.
export const AGY_BUSY_MARKERS = ['Generating']

// After the signed-in banner appears, give the TUI 1 500 ms to finish
// painting the input box before the first message is written. A shorter
// window risks sending keystrokes before stdin is fully wired up.
export const AGY_IDLE_READY_MS = 1500

// agy authenticates consumer accounts via the gnome login keyring ONLY (the file
// token is a storage-fallback cache, never an auth source). When agy detects an
// SSH session — which the runner is, since it inherits SSH_* from the user's
// login — it takes a degraded keyring path with 1s/5s timeouts that fall back to
// (empty) file storage and fails to sign in. Stripping the SSH markers makes agy
// use the normal keyring path, which reads the unlocked login keyring instantly.
// (The keyring must be unlocked on the runner's bus for this to succeed.)
function agySshEnvKeys(): string[] {
    return Object.keys(process.env).filter((k) => k.startsWith('SSH_'))
}

export function buildAgyPtyExtraEnv(opts: Pick<AgyPtyOpts, 'hookPort' | 'hookToken'>): Record<string, string> {
    const env: Record<string, string> = {
        TERM: 'xterm-256color',
        GEMINI_FORCE_FILE_STORAGE: 'true',
    }
    if (opts.hookPort !== undefined) env.HAPI_AGY_HOOK_PORT = String(opts.hookPort)
    if (opts.hookToken !== undefined) env.HAPI_AGY_HOOK_TOKEN = opts.hookToken
    return env
}

export async function agyPty(opts: AgyPtyOpts): Promise<void> {
    return runAgentPty({
        command: 'agy',
        args: buildAgyPtyArgs(opts),
        cwd: opts.path,
        envVars: opts.agyEnvVars,
        extraEnv: buildAgyPtyExtraEnv(opts),
        unsetEnv: agySshEnvKeys(),
        promptMarkers: AGY_PROMPT_MARKERS,
        trustMarkers: AGY_TRUST_MARKERS,
        authFailureMarkers: AGY_AUTH_FAILURE_MARKERS,
        busyMarkers: AGY_BUSY_MARKERS,
        idleReadyMs: AGY_IDLE_READY_MS,
        idleMarkers: AGY_IDLE_MARKERS,
        debugPrefix: '[agyPty]',
        signal: opts.signal,
        nextMessage: opts.nextMessage,
        onReady: opts.onReady,
        onMessage: opts.onMessage,
        onThinkingChange: opts.onThinkingChange,
        onExit: opts.onExit,
        onAuthFailure: opts.onAuthFailure,
        registerControls: opts.registerControls,
    })
}
