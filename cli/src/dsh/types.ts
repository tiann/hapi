/**
 * HAPI-side stable types for the DeepSeek Harness integration layer.
 *
 * Everything outside `cli/src/dsh/` must depend only on these types (plus the
 * official wire contracts re-exported through `DshClient`), never on Cordis /
 * DSH internal types. DSH breaking changes should be absorbed inside this
 * directory.
 */

/** Version of the official DeepSeek Harness runtime HAPI spawns. */
export const DSH_RUNTIME_VERSION = '0.1.0-rc.6' as const

/** Environment variable that overrides the DSH runtime binary path. */
export const DSH_RUNTIME_PATH_ENV = 'HAPI_DSH_RUNTIME_PATH' as const

/** Environment variable that disables the automatic DSH runtime install. */
export const DSH_RUNTIME_NO_INSTALL_ENV = 'HAPI_DSH_NO_INSTALL' as const

/** Fixed subdirectory under HAPI_HOME where the DSH runtime is installed. */
export const DSH_RUNTIME_DIR_NAME = 'dsh-runtime' as const

/** Host facts sampled from the official `host.describe` response. */
export type DshHostInfo = {
    /**
     * DSH host app version as reported by the host itself. Note this is the
     * host's internal app version ('0.0.1' as of rc.6), NOT the npm release
     * version — {@link DSH_RUNTIME_VERSION} pins the installed package.
     */
    version: string
    /** Host process working directory (session persistence / tool root). */
    cwd: string
    /** Configured default provider route, when the host has one. */
    provider?: string
    /** Configured default model, when the host has one. */
    model?: string
    /** Number of currently attached sessions (live agents). */
    attachedSessions: number
    /** Whether this deployment can hand a path to a native opener. */
    canOpenPath: boolean
}

/** One established DSH host process. */
export type DshHostHandle = {
    /** The host child process. */
    process: import('node:child_process').ChildProcess
    /** Loopback base URL of the host API (http://127.0.0.1:<port>). */
    baseUrl: string
    /** Host facts from the readiness handshake. */
    info: DshHostInfo
    /** Installed npm release version (from the dsh package manifest). */
    runtimeVersion: string
    /** Listen port. */
    port: number
    /** Stop the host gracefully (SIGTERM) and await exit. */
    stop(options?: { timeoutMs?: number }): Promise<void>
}

/** Options for spawning a DSH host process. */
export type DshRuntimeOptions = {
    /** Working directory for the DSH host process (the session directory). */
    cwd: string
    /** Explicit runtime binary path (defaults to HAPI_HOME/dsh-runtime). */
    runtimeBin?: string
    /** Explicit DSH_HOME override for the host process. */
    dshHome?: string
    /** Preferred listen port; HAPI probes a free port when omitted. */
    port?: number
    /** Extra environment variables for the host process. */
    env?: Record<string, string>
    /** Readiness timeout (default 30s). */
    readyTimeoutMs?: number
    /** Log tag prefix for diagnostics. */
    logTag?: string
}

/** Result of a spawn attempt that failed before readiness. */
export type DshRuntimeStartError = {
    kind: 'spawn' | 'timeout' | 'exit' | 'install'
    message: string
    /** stderr tail captured from the failed host process. */
    stderrTail?: string
}
