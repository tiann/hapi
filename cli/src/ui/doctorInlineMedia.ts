/**
 * Inline media bridge diagnostics (display_image / display_video / display_media + helper script).
 */

import chalk from 'chalk'
import { cliT } from '@/i18n/cliI18n'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { configuration } from '@/configuration'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import { readSettings } from '@/persistence'
import { projectPath } from '@/projectPath'
import { cursorHapiMcpServerId } from '@/cursor/utils/cursorMcpOverlay'

export type InlineMediaDoctorCheck = {
    id: 'helper' | 'sdk' | 'sessionId' | 'hubAuth'
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

function repoRootFromCli(): string {
    return resolve(projectPath(), '..')
}

export function inlineMediaHelperScriptPath(): string {
    return join(repoRootFromCli(), 'scripts/tooling/hapi-display-image.mjs')
}

function mcpSdkResolvable(): boolean {
    const candidates = [
        join(projectPath(), 'node_modules/@modelcontextprotocol/sdk/package.json'),
        join(repoRootFromCli(), 'node_modules/@modelcontextprotocol/sdk/package.json'),
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
    console.log(chalk.bold.cyan(`\n${cliT('doctor.inline.title')}\n`))

    const checks: InlineMediaDoctorCheck[] = []
    const scriptPath = inlineMediaHelperScriptPath()
    const scriptExists = existsSync(scriptPath)
    checks.push({
        id: 'helper',
        ok: scriptExists,
        label: cliT('doctor.inline.check.helper'),
        detail: scriptExists ? scriptPath : cliT('doctor.inline.check.helperMissing', { path: scriptPath }),
    })

    const sdkOk = mcpSdkResolvable()
    checks.push({
        id: 'sdk',
        ok: sdkOk,
        label: cliT('doctor.inline.check.sdk'),
        detail: sdkOk ? cliT('doctor.inline.check.sdkOk') : cliT('doctor.inline.check.sdkMissing'),
    })

    const envSessionId = process.env.HAPI_SESSION_ID
    if (envSessionId) {
        checks.push({
            id: 'sessionId',
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
        id: 'hubAuth',
        ok: jwt !== null,
        label: cliT('doctor.inline.check.hubAuth'),
        detail: jwt ? configuration.apiUrl : cliT('doctor.inline.check.hubAuthMissing'),
    })

    for (const check of checks) {
        const mark = check.ok
            ? chalk.green('✓')
            : (check.id === 'hubAuth' ? chalk.red('✗') : chalk.yellow('○'))
        console.log(`${mark} ${check.label}: ${chalk.gray(check.detail)}`)
    }

    if (!jwt) {
        console.log(chalk.red(`\n${cliT('doctor.inline.noAuth')}\n`))
        return 1
    }

    let bridges: InlineMediaSessionBridge[] = []
    try {
        bridges = await collectInlineMediaSessionBridges(jwt)
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.log(chalk.red(`\n${cliT('doctor.inline.probeFailed', { error: msg })}\n`))
        return 1
    }

    const withBridge = bridges.filter((b) => b.hapiMcpUrl)
    const listOmitsMcp = bridges.some((b) => b.hapiMcpUrl && !b.listShowsMcpUrl)
    const shellFallbackAvailable = scriptExists && sdkOk

    console.log(chalk.bold(`\n${cliT('doctor.inline.sessions')}`))
    if (bridges.length === 0) {
        console.log(chalk.yellow(cliT('doctor.inline.noSessions')))
    } else {
        for (const b of bridges) {
            const bridgeMark = b.hapiMcpUrl ? chalk.green(cliT('doctor.inline.bridge')) : chalk.yellow(cliT('doctor.inline.noBridge'))
            const title = b.name ?? b.path ?? b.id
            console.log(
                `  ${chalk.blue(b.prefix)} ${bridgeMark} ${chalk.gray(title)}`
                + (b.flavor ? chalk.gray(` (${b.flavor})`) : '')
            )
            if (b.hapiMcpUrl) {
                console.log(chalk.gray(`    mcp: ${b.hapiMcpUrl}`))
                if (shellFallbackAvailable) {
                    console.log(chalk.gray(`    ${formatInlineMediaCommand(scriptPath, b.prefix)}`))
                }
            }
        }
    }

    if (listOmitsMcp) {
        console.log(chalk.yellow(`\n${cliT('doctor.inline.listOmitsMcp')}`))
    }

    const cursorSessions = withBridge.filter((b) => b.flavor === 'cursor')
    if (cursorSessions.length > 0) {
        console.log(chalk.bold('\nCursor ACP'))
        console.log(chalk.gray(cliT('doctor.inline.cursorNote1')))
        console.log(chalk.gray(cliT('doctor.inline.cursorNote2')))
        for (const session of cursorSessions) {
            const serverId = cursorHapiMcpServerId(session.id)
            console.log(chalk.gray(cliT('doctor.inline.cursorVerify', { prefix: session.prefix, serverId })))
        }
    }

    console.log(chalk.bold(`\n${cliT('doctor.inline.agentTitle')}`))
    console.log(chalk.gray(cliT('doctor.inline.agentStep1')))
    if (shellFallbackAvailable) {
        console.log(chalk.gray(cliT('doctor.inline.agentStep2')))
        if (withBridge.length > 0) {
            console.log(chalk.green(`    ${formatInlineMediaCommand(scriptPath, withBridge[0].prefix)}`))
        } else if (envSessionId) {
            console.log(chalk.green(`    ${formatInlineMediaCommand(scriptPath, envSessionId.slice(0, 8))}`))
        } else {
            console.log(chalk.gray(`    ${formatInlineMediaCommand(scriptPath, '<hapi-session-prefix>')}`))
        }
    } else {
        console.log(chalk.gray(cliT('doctor.inline.agentStep2Unavailable')))
    }

    // Core health: hub auth + live bridge or session id. Repo shell helper is optional.
    const ok = jwt !== null && (withBridge.length > 0 || Boolean(envSessionId))

    if (ok) {
        console.log(chalk.green(`\n${cliT('doctor.inline.ok')}\n`))
        return 0
    }

    if (withBridge.length === 0 && !envSessionId) {
        console.log(chalk.yellow(`\n${cliT('doctor.inline.noSession')}\n`))
    } else {
        console.log(chalk.red(`\n${cliT('doctor.inline.failed')}\n`))
    }
    return 1
}
