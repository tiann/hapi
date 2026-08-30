import spawn from 'cross-spawn'
import { withBunRuntimeEnv } from '@/utils/bunRuntime'
import { resolveCodexCommand } from './codexExecutable'
import type { CodexMcpServerInventory } from '@/agent/contextDetails'

export const CODEX_MCP_LIST_TIMEOUT_MS = 5_000

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asToolNames(value: unknown): string[] | undefined {
    const items = Array.isArray(value)
        ? value
        : asRecord(value)
            ? Object.entries(asRecord(value)!).map(([name]) => name)
            : []
    if (items.length === 0) return undefined
    const names = items.flatMap((item) => {
        const name = typeof item === 'string' ? asString(item) : asString(asRecord(item)?.name)
        return name ? [name] : []
    })
    return names.length > 0 ? Array.from(new Set(names)) : undefined
}

function parseInventoryEntries(value: unknown): CodexMcpServerInventory[] {
    const record = asRecord(value)
    const entries = Array.isArray(value)
        ? value
        : Array.isArray(record?.data)
            ? record.data
            : []

    return entries.flatMap((entry) => {
        const item = asRecord(entry)
        const name = asString(item?.name ?? item?.serverName ?? item?.server_name)
        if (!name) return []
        const enabled = item?.enabled
        const status = asString(
            item?.status
            ?? item?.state
            ?? item?.authStatus
            ?? item?.auth_status
            ?? (enabled === false ? 'disabled' : undefined)
        )
        const toolNames = asToolNames(item?.toolNames ?? item?.tool_names ?? item?.tools)
        return [{
            name,
            ...(toolNames ? { toolNames } : {}),
            ...(status && status !== 'unsupported' ? { status } : {})
        }]
    })
}

export function parseCodexMcpInventoryOutput(output: string): CodexMcpServerInventory[] {
    try {
        return parseInventoryEntries(JSON.parse(output))
    } catch {
        return []
    }
}

export function parseCodexMcpStatusResponse(value: unknown): CodexMcpServerInventory[] {
    return parseInventoryEntries(value)
}

export function mergeCodexMcpInventories(
    ...inventories: readonly CodexMcpServerInventory[][]
): CodexMcpServerInventory[] {
    const byName = new Map<string, CodexMcpServerInventory>()
    for (const inventory of inventories) {
        for (const server of inventory) {
            const previous = byName.get(server.name)
            byName.set(server.name, {
                ...previous,
                ...server,
                ...(server.toolNames === undefined && previous?.toolNames
                    ? { toolNames: previous.toolNames }
                    : {}),
                ...(server.status === undefined && previous?.status
                    ? { status: previous.status }
                    : {})
            })
        }
    }
    return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name))
}

export function listConfiguredCodexMcpServers(cwd?: string): Promise<CodexMcpServerInventory[]> {
    const resolved = resolveCodexCommand()
    return new Promise((resolveInventory) => {
        let stdout = ''
        let settled = false
        const child = spawn(resolved.command, [
            ...resolved.args,
            'mcp',
            'list',
            '--json'
        ], {
            env: withBunRuntimeEnv(),
            ...(cwd ? { cwd } : {}),
            windowsHide: process.platform === 'win32'
        })
        const finish = (inventory: CodexMcpServerInventory[]): void => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolveInventory(inventory)
        }
        const timeout = setTimeout(() => {
            child.kill()
            finish([])
        }, CODEX_MCP_LIST_TIMEOUT_MS)
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
            stdout += chunk
        })
        child.on('error', () => finish([]))
        child.on('close', (code) => {
            finish(code === 0 ? parseCodexMcpInventoryOutput(stdout) : [])
        })
    })
}
