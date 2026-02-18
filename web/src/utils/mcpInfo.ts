export interface McpServerInfo {
    name: string
    displayName: string
    tools: string[]
}

/**
 * Parse MCP server info from session.metadata.tools.
 * MCP tools follow the naming convention: mcp__<serverName>__<toolName>
 */
export function parseMcpServers(tools: string[] | undefined): McpServerInfo[] {
    if (!tools || tools.length === 0) return []

    const serverMap = new Map<string, string[]>()

    for (const tool of tools) {
        if (!tool.startsWith('mcp__')) continue

        // Parse: mcp__<serverName>__<toolName>
        const withoutPrefix = tool.slice(5) // remove 'mcp__'
        const separatorIndex = withoutPrefix.indexOf('__')
        if (separatorIndex === -1) continue

        const serverName = withoutPrefix.slice(0, separatorIndex)
        const toolName = withoutPrefix.slice(separatorIndex + 2)

        if (!serverMap.has(serverName)) {
            serverMap.set(serverName, [])
        }
        serverMap.get(serverName)!.push(toolName)
    }

    return Array.from(serverMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, serverTools]) => ({
            name,
            displayName: formatServerName(name),
            tools: serverTools.sort()
        }))
}

function formatServerName(name: string): string {
    // Convert underscored names to readable format
    // e.g. "claude_ai_Tavily" → "Claude AI Tavily"
    return name
        .split('_')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
}
