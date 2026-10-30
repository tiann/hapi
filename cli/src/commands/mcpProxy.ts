import { runHappyMcpStdioProxy } from '@/codex/happyMcpStdioProxy'
import type { CommandDefinition } from './types'

export const mcpProxyCommand: CommandDefinition = {
    name: 'mcp-proxy',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        await runHappyMcpStdioProxy(commandArgs)
    }
}
