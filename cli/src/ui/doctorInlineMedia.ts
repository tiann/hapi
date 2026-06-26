/**
 * Inline media bridge diagnostics (display_image / display_video + helper script).
 */

import chalk from 'chalk'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { configuration } from '@/configuration'
import { readSettings } from '@/persistence'
import { projectPath } from '@/projectPath'

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

async function hubJwt(): Promise<string | null> {
    const settings = await readSettings()
    const token = process.env.CLI_API_TOKEN ?? settings.cliApiToken
    if (!token) {
        return null
    }
    const res = await fetch(`${configuration.apiUrl}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    return `cd ${scriptDir} && bun scripts/tooling/hapi-display-image.mjs ${sessionPrefix} ${samplePath} "title"`
}

export async function collectInlineMediaSessionBridges(jwt: string): Promise<InlineMediaSessionBridge[]> {
    const listRes = await fetch(`${configuration.apiUrl}/api/sessions?limit=200`, {
        headers: { Authorization: `Bearer ${jwt}` },
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
            { headers: { Authorization: `Bearer ${jwt}` } }
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
    const scriptPath = inlineMediaHelperScriptPath()
    const scriptExists = existsSync(scriptPath)
    checks.push({
        ok: scriptExists,
        label: 'Helper script',
        detail: scriptExists ? scriptPath : `missing: ${scriptPath}`,
    })

    const sdkOk = mcpSdkResolvable()
    checks.push({
        ok: sdkOk,
        label: '@modelcontextprotocol/sdk',
        detail: sdkOk ? 'resolvable from cli or repo root' : 'not found — run bun install from repo root',
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
        const mark = check.ok ? chalk.green('✓') : chalk.red('✗')
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
                console.log(chalk.gray(`    ${formatInlineMediaCommand(scriptPath, b.prefix)}`))
            }
        }
    }

    if (listOmitsMcp) {
        console.log(chalk.yellow(
            '\n⚠ Some active sessions have hapiMcpUrl on detail GET but not on list — upgrade hub or use per-session GET.'
        ))
    }

    console.log(chalk.bold('\nAgent inline path'))
    console.log(chalk.gray('  1. MCP tool display_image / display_video in the running session (ACP flavors via hapi bridge)'))
    console.log(chalk.gray('  2. Shell fallback (HAPI session id prefix, not cursorSessionId):'))
    if (withBridge.length > 0) {
        console.log(chalk.green(`    ${formatInlineMediaCommand(scriptPath, withBridge[0].prefix)}`))
    } else if (envSessionId) {
        console.log(chalk.green(`    ${formatInlineMediaCommand(scriptPath, envSessionId.slice(0, 8))}`))
    } else {
        console.log(chalk.gray(`    ${formatInlineMediaCommand(scriptPath, '<hapi-session-prefix>')}`))
    }

    const ok =
        scriptExists
        && sdkOk
        && jwt !== null
        && (withBridge.length > 0 || Boolean(envSessionId))

    if (ok) {
        console.log(chalk.green('\n✓ Inline media path available\n'))
        return 0
    }

    if (withBridge.length === 0 && !envSessionId) {
        console.log(chalk.yellow('\n⚠ No active session with hapiMcpUrl — start or resume a remote session first.\n'))
    } else {
        console.log(chalk.red('\n✗ Inline media checks failed — fix items marked ✗ above.\n'))
    }
    return withBridge.length > 0 ? 0 : 1
}
