import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { logger } from "@/lib"

// Temp config dirs still pending cleanup. The normal path removes a dir via
// cleanupTrustedConfigDir (claudePty's finally), but session archive (KillSession
// RPC) and SIGTERM/SIGINT terminate the runner with process.exit(), which skips
// that finally. A synchronous 'exit' handler reaps whatever is still registered
// so these temp dirs don't pile up in /tmp across sessions.
const pendingConfigDirs = new Set<string>()
let exitHandlerRegistered = false

function ensureExitCleanupRegistered(): void {
    if (exitHandlerRegistered) return
    exitHandlerRegistered = true
    // 'exit' callbacks must be synchronous; rmSync fits. It does not follow
    // symlinks, so the real ~/.claude the dir links to is preserved.
    process.on('exit', () => {
        for (const dir of pendingConfigDirs) {
            try {
                rmSync(dir, { recursive: true, force: true })
            } catch {
                // best-effort; process is exiting
            }
        }
        pendingConfigDirs.clear()
    })
}

/**
 * Build an isolated CLAUDE_CONFIG_DIR that shares the user's real Claude state
 * but pre-trusts the working folder — so the first-run "Is this a project you
 * trust?" prompt never appears in PTY mode, WITHOUT mutating the user's own
 * ~/.claude.json.
 *
 * How: every entry in the real config dir (credentials, projects/transcripts,
 * settings, hooks, ...) is symlinked into a fresh temp dir, so login state and
 * transcripts stay shared with the real install. Only `.claude.json` is a
 * private copy, with `projects[cwd].hasTrustDialogAccepted = true` added.
 *
 * Claude resolves `.claude.json` and everything else from CLAUDE_CONFIG_DIR, so
 * pointing the spawned process at this temp dir suppresses the trust prompt.
 * The parent process's process.env is left untouched (see runAgentPty), so the
 * session scanner still resolves transcripts against the real ~/.claude (which
 * the symlinked `projects` entry points back to).
 *
 * Returns the temp dir path, or undefined if preparation failed (caller then
 * falls back to the runtime trust-prompt auto-approve).
 */
export function prepareTrustedConfigDir(cwd: string): string | undefined {
    try {
        const realConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
        const realDotJson = join(homedir(), '.claude.json')

        const dir = mkdtempSync(join(tmpdir(), 'hapi-claude-cfg-'))
        pendingConfigDirs.add(dir)
        ensureExitCleanupRegistered()

        // Share all real config state via symlinks (login, transcripts, settings).
        // `.claude.json` is skipped here — it lives in homedir, not in the config
        // dir, and we want a private trust-patched copy anyway.
        for (const entry of readdirSync(realConfigDir)) {
            // Never symlink `.claude.json`: we write a private trust-patched copy
            // below, and writeFileSync would follow the symlink and mutate the
            // real file (only reachable when CLAUDE_CONFIG_DIR points at a dir
            // that itself holds a .claude.json; the default ~/.claude does not).
            if (entry === '.claude.json') {
                continue
            }
            try {
                symlinkSync(join(realConfigDir, entry), join(dir, entry))
            } catch (e) {
                logger.debug(`[trustedConfigDir] failed to symlink ${entry}`, e)
            }
        }

        // Private .claude.json with the folder pre-trusted. Original untouched.
        let config: Record<string, unknown> = {}
        try {
            config = JSON.parse(readFileSync(realDotJson, 'utf-8'))
        } catch (e) {
            logger.debug('[trustedConfigDir] could not read ~/.claude.json; starting fresh', e)
        }
        const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>
        projects[cwd] = { ...(projects[cwd] ?? {}), hasTrustDialogAccepted: true }
        config.projects = projects
        writeFileSync(join(dir, '.claude.json'), JSON.stringify(config))

        logger.debug(`[trustedConfigDir] prepared isolated config at ${dir} (folder pre-trusted)`)
        return dir
    } catch (e) {
        logger.debug('[trustedConfigDir] preparation failed; relying on trust auto-approve', e)
        return undefined
    }
}

/**
 * Remove a temp config dir created by prepareTrustedConfigDir. Symlinked entries
 * are unlinked (Node's rm does not follow symlinks), so the real ~/.claude state
 * they point to is preserved.
 */
export function cleanupTrustedConfigDir(dir: string | undefined): void {
    if (!dir) return
    pendingConfigDirs.delete(dir)
    try {
        rmSync(dir, { recursive: true, force: true })
    } catch (e) {
        logger.debug(`[trustedConfigDir] cleanup failed for ${dir}`, e)
    }
}
