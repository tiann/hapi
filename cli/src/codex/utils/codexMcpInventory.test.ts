import { describe, expect, it } from 'vitest'
import {
    mergeCodexMcpInventories,
    parseCodexMcpInventoryOutput,
    parseCodexMcpStatusResponse
} from './codexMcpInventory'

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
