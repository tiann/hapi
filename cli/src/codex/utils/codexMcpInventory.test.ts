import { describe, expect, it } from 'vitest'
import {
    filterCodexInventoryArgs,
    mergeCodexMcpInventories,
    parseCodexMcpInventoryOutput,
    parseCodexMcpStatusResponse
} from './codexMcpInventory'
import { buildCodexContextDetails } from '@/agent/contextDetails'

describe('codex MCP inventory', () => {
    it('parses configured non-HAPI servers without persisting commands or secrets', () => {
        const inventory = parseCodexMcpInventoryOutput(JSON.stringify([{
            name: 'qmd',
            enabled: true,
            transport: {
                type: 'stdio',
                command: 'node',
                args: ['server.js'],
                env: { TOKEN: 'secret' }
            },
            auth_status: 'unsupported'
        }]))

        expect(inventory).toEqual([{ name: 'qmd' }])
        expect(JSON.stringify(inventory)).not.toContain('secret')
        expect(JSON.stringify(inventory)).not.toContain('server.js')
    })

    it('distinguishes invalid command output from a successful empty inventory', () => {
        expect(parseCodexMcpInventoryOutput('not json')).toBeUndefined()
        expect(parseCodexMcpInventoryOutput('[]')).toEqual([])
        expect(parseCodexMcpStatusResponse({ data: [] })).toEqual([])
        expect(parseCodexMcpStatusResponse({ unexpected: [] })).toBeUndefined()
    })

    it('passes only configuration selectors to the MCP inventory command', () => {
        expect(filterCodexInventoryArgs([
            '--profile', 'work',
            '-c', 'model="gpt-5.6"',
            '--config=mcp_servers.qmd.enabled=true',
            '--enable', 'feature-x',
            '--disable=feature-y',
            '--sandbox', 'workspace-write',
            '--model', 'gpt-5.6',
            'resume', '--last'
        ])).toEqual([
            '--profile', 'work',
            '-c', 'model="gpt-5.6"',
            '--config=mcp_servers.qmd.enabled=true',
            '--enable', 'feature-x',
            '--disable=feature-y'
        ])
    })

    it('parses resolved server status and tool names', () => {
        expect(parseCodexMcpStatusResponse({
            data: [{
                name: 'qmd',
                status: 'ready',
                tools: [{ name: 'search' }, { name: 'fetch' }]
            }]
        })).toEqual([{
            name: 'qmd',
            status: 'ready',
            toolNames: ['search', 'fetch']
        }])
    })

    it('preserves disabled status over authentication status', () => {
        expect(parseCodexMcpStatusResponse({
            data: [{ name: 'qmd', enabled: false, auth_status: 'unsupported' }]
        })).toEqual([{ name: 'qmd', status: 'disabled' }])
    })

    it.each([{}, []])('preserves an authoritative empty runtime tool list: %j', (tools) => {
        const inventory = parseCodexMcpStatusResponse({
            data: [{ name: 'qmd', tools }]
        })
        const details = buildCodexContextDetails({
            updatedAt: 100,
            mcpServers: {
                qmd: { command: 'qmd', args: [], tools: { search: {} } }
            },
            mcpServerInventory: inventory
        })

        expect(details.codex?.mcpServers).toEqual([{ name: 'qmd', toolNames: [] }])
    })

    it('merges resolved fields over configured server names', () => {
        expect(mergeCodexMcpInventories(
            [{ name: 'qmd' }, { name: 'other' }],
            [{ name: 'qmd', status: 'ready', toolNames: ['search'] }]
        )).toEqual([
            { name: 'other' },
            { name: 'qmd', status: 'ready', toolNames: ['search'] }
        ])
    })
})
