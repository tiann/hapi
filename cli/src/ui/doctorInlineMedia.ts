/**
 * Inline media bridge diagnostics (display_image / display_video / display_media + helper script).
 */

import chalk from 'chalk'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { configuration } from '@/configuration'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import { readSettings } from '@/persistence'
import { isBunCompiled, projectPath } from '@/projectPath'
import { cursorHapiMcpServerId } from '@/cursor/utils/cursorMcpOverlay'

export type InlineMediaDoctorCheck = {
    ok: boolean
    label: string
    detail: string
}

export type InlineMediaSessionBridge = {
    id: string
    prefix: string
    flavor: string | null
    hapiMcpUrl: string | null
    listShowsMcpUrl: boolean
    path: string | null
    name: string | null
}

/**
 * Repo root used to locate the shell-fallback helper script.
 *
 * A Bun-compiled (packaged) install has no repo checkout: `projectPath()` resolves inside
 * Bun's virtual filesystem (`B:/~BUN/root` on Windows, `/$bunfs/root` elsewhere) and
 * `resolve()` clamps at that virtual drive root, so deriving any path from it yields
 * something like `B:\scripts\tooling\...`, which exists on no real volume. Report the
 * absence of a checkout instead of inventing an element of one.
 */
function repoRootFromCli(): string | null {
    if (isBunCompiled()) {
        return null
    }
    return resolve(projectPath(), '..')
}

/** Absolute path to the shell-fallback helper script, or null when this install has no repo checkout. */
export function inlineMediaHelperScriptPath(): string | null {
    const repoRoot = repoRootFromCli()
    return repoRoot === null ? null : join(repoRoot, 'scripts/tooling/hapi-display-image.mjs')
}

function mcpSdkResolvable(): boolean {
    const repoRoot = repoRootFromCli()
    if (repoRoot === null) {
        return false
    }
    const candidates = [
        join(projectPath(), 'node_modules/@modelcontextprotocol/sdk/package.json'),
        join(repoRoot, 'node_modules/@modelcontextprotocol/sdk/package.json'),
    ]
    return candidates.some((p) => existsSync(p))
}

/** POSIX-safe single-quote wrapping (handles embedded quotes). */
export function shellSingleQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`
}

async function hubJwt(): Promise<string | null> {
    const settings = await readSettings()
    const token = process.env.CLI_API_TOKEN ?? settings.cliApiToken
    if (!token) {
        return null
    }
    const res = await fetch(`${configuration.apiUrl}/api/auth`, {
        method: 'POST',
        headers: buildHubRequestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ accessToken: token }),
    })
    if (!res.ok) {
        return null
    }
    const body = (await res.json()) as { token?: string }
    return body.token ?? null
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function sessionDisplayName(metadata: Record<string, unknown> | null): string | null {
    if (!metadata) return null
    const name = metadata.name
    return typeof name === 'string' ? name : null
}

export function formatInlineMediaCommand(
    scriptPath: string,
    sessionPrefix: string,
    samplePath = '/absolute/path/to/image.png'
): string {
    const scriptDir = resolve(scriptPath, '..', '..', '..')
    const q = shellSingleQuote
    return `cd ${q(scriptDir)} && bun scripts/tooling/hapi-display-image.mjs ${q(sessionPrefix)} ${q(samplePath)} "title"`
}

export async function collectInlineMediaSessionBridges(jwt: string): Promise<InlineMediaSessionBridge[]> {
    const listRes = await fetch(`${configuration.apiUrl}/api/sessions?limit=200`, {
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` }),
    })
    if (!listRes.ok) {
        throw new Error(`sessions list failed: ${listRes.status}`)
    }
    const listBody = (await listRes.json()) as { sessions?: unknown[] }
    const sessions = Array.isArray(listBody.sessions) ? listBody.sessions : []
    const active = sessions.filter((s) => asRecord(s)?.active === true)

    const bridges: InlineMediaSessionBridge[] = []
    for (const row of active) {
        const summary = asRecord(row)
        if (!summary || typeof summary.id !== 'string') continue
        const listMeta = asRecord(summary.metadata)
        const listMcp = listMeta && typeof listMeta.hapiMcpUrl === 'string' ? listMeta.hapiMcpUrl : null

        const detailRes = await fetch(
            `${configuration.apiUrl}/api/sessions/${encodeURIComponent(summary.id)}`,
            { headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` }) }
        )
        if (!detailRes.ok) continue
        const detailBody = (await detailRes.json()) as { session?: unknown }
        const detailRow = asRecord(detailBody.session) ?? asRecord(detailBody)
        const detailMeta = asRecord(detailRow?.metadata)
        const detailMcp = detailMeta && typeof detailMeta.hapiMcpUrl === 'string' ? detailMeta.hapiMcpUrl : null
        const flavor = detailMeta && typeof detailMeta.flavor === 'string' ? detailMeta.flavor : null
        const path = detailMeta && typeof detailMeta.path === 'string' ? detailMeta.path : null

        bridges.push({
            id: summary.id,
            prefix: summary.id.slice(0, 8),
            flavor,
            hapiMcpUrl: detailMcp,
            listShowsMcpUrl: listMcp !== null,
            path,
            name: sessionDisplayName(detailMeta),
        })
    }
    return bridges
}

export async function runDoctorInlineMedia(): Promise<number> {
    console.log(chalk.bold.cyan('\n🖼️  hapi inline media doctor\n'))

    const checks: InlineMediaDoctorCheck[] = []
    const helperScriptPath = inlineMediaHelperScriptPath()
    const helperScriptExists = helperScriptPath !== null && existsSync(helperScriptPath)

    let helperScriptDetail: string
    if (helperScriptPath === null) {
        helperScriptDetail = 'not applicable (packaged install — use the MCP tools)'
    } else if (helperScriptExists) {
        helperScriptDetail = helperScriptPath
    } else {
        helperScriptDetail = `missing: ${helperScriptPath} (optional outside source checkout)`
    }
    checks.push({
        ok: helperScriptExists,
        label: 'Helper script (repo shell fallback)',
        detail: helperScriptDetail,
    })

    const sdkOk = mcpSdkResolvable()
    checks.push({
        ok: sdkOk,
        label: '@modelcontextprotocol/sdk (repo shell fallback)',
        detail: helperScriptPath === null
            ? 'not applicable (packaged install)'
            : (sdkOk ? 'resolvable from cli or repo root' : 'not found — optional outside source checkout'),
    })

    const envSessionId = process.env.HAPI_SESSION_ID
    if (envSessionId) {
        checks.push({
            ok: true,
            label: 'HAPI_SESSION_ID',
            detail: envSessionId,
        })
    }

    let jwt: string | null = null
    try {
        jwt = await hubJwt()
    } catch {
        jwt = null
    }
    checks.push({
        ok: jwt !== null,
        label: 'Hub auth',
        detail: jwt ? configuration.apiUrl : 'CLI_API_TOKEN missing or auth failed',
    })

    for (const check of checks) {
        const mark = check.ok
            ? chalk.green('✓')
            : (check.label === 'Hub auth' ? chalk.red('✗') : chalk.yellow('○'))
        console.log(`${mark} ${check.label}: ${chalk.gray(check.detail)}`)
    }

    if (!jwt) {
        console.log(chalk.red('\nCannot probe sessions without hub auth.\n'))
        return 1
    }

    let bridges: InlineMediaSessionBridge[] = []
    try {
        bridges = await collectInlineMediaSessionBridges(jwt)
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.log(chalk.red(`\n✗ Session probe failed: ${msg}\n`))
        return 1
    }

    const withBridge = bridges.filter((b) => b.hapiMcpUrl)
    const listOmitsMcp = bridges.some((b) => b.hapiMcpUrl && !b.listShowsMcpUrl)
    // The repo shell fallback needs an actual checkout: helper script present and its MCP SDK resolvable.
    const shellFallbackScriptPath = helperScriptExists && sdkOk ? helperScriptPath : null

    console.log(chalk.bold('\nActive sessions'))
    if (bridges.length === 0) {
        console.log(chalk.yellow('  No active sessions on hub.'))
    } else {
        for (const b of bridges) {
            const bridgeMark = b.hapiMcpUrl ? chalk.green('bridge') : chalk.yellow('no bridge')
            const title = b.name ?? b.path ?? b.id
            console.log(
                `  ${chalk.blue(b.prefix)} ${bridgeMark} ${chalk.gray(title)}`
                + (b.flavor ? chalk.gray(` (${b.flavor})`) : '')
            )
            if (b.hapiMcpUrl) {
                console.log(chalk.gray(`    mcp: ${b.hapiMcpUrl}`))
                if (shellFallbackScriptPath) {
                    console.log(chalk.gray(`    ${formatInlineMediaCommand(shellFallbackScriptPath, b.prefix)}`))
                }
            }
        }
    }

    if (listOmitsMcp) {
        console.log(chalk.yellow(
            '\n⚠ Some active sessions have hapiMcpUrl on detail GET but not on list — upgrade hub or use per-session GET.'
        ))
    }

    const cursorSessions = withBridge.filter((b) => b.flavor === 'cursor')
    if (cursorSessions.length > 0) {
        console.log(chalk.bold('\nCursor ACP'))
        console.log(chalk.gray('  Cursor ignores session/new mcpServers. Remote sessions use ~/.cursor/mcp.json + `agent mcp enable hapi-<sessionId>`.'))
        console.log(chalk.gray('  Tool names are bare: display_image, display_video, display_media, change_title (not hapi_display_image).'))
        for (const session of cursorSessions) {
            const serverId = cursorHapiMcpServerId(session.id)
            console.log(chalk.gray(`  Verify (${session.prefix}): agent mcp list-tools ${serverId}`))
        }
    }

    console.log(chalk.bold('\nAgent inline path'))
    console.log(chalk.gray('  1. MCP tool display_image / display_video / display_media in the running session (ACP flavors via hapi bridge)'))
    if (shellFallbackScriptPath) {
        console.log(chalk.gray('  2. Shell fallback (HAPI session id prefix, not cursorSessionId):'))
        if (withBridge.length > 0) {
            console.log(chalk.green(`    ${formatInlineMediaCommand(shellFallbackScriptPath, withBridge[0].prefix)}`))
        } else if (envSessionId) {
            console.log(chalk.green(`    ${formatInlineMediaCommand(shellFallbackScriptPath, envSessionId.slice(0, 8))}`))
        } else {
            console.log(chalk.gray(`    ${formatInlineMediaCommand(shellFallbackScriptPath, '<hapi-session-prefix>')}`))
        }
    } else {
        console.log(chalk.gray('  2. Shell fallback unavailable (packaged install / no repo checkout) — use MCP tools only'))
    }

    // Core health: hub auth + live bridge or session id. Repo shell helper is optional.
    const ok = jwt !== null && (withBridge.length > 0 || Boolean(envSessionId))

    if (ok) {
        console.log(chalk.green('\n✓ Inline media path available\n'))
        return 0
    }

    if (withBridge.length === 0 && !envSessionId) {
        console.log(chalk.yellow('\n⚠ No active session with hapiMcpUrl — start or resume a remote session first.\n'))
    } else {
        console.log(chalk.red('\n✗ Inline media checks failed — fix items marked ✗ above.\n'))
    }
    return 1
}
