/**
 * Flavor-specific tool ids (OpenCode reports its built-ins by lowercase id)
 * resolved to the canonical presentation names, shared by every presentation
 * path. Identity for any name not listed.
 */
export const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
    bash: 'Bash',
    glob: 'Glob',
    grep: 'Grep',
    list: 'LS',
    write: 'Write',
    edit: 'Edit',
    webfetch: 'WebFetch',
    websearch: 'WebSearch',
    task: 'Task'
}

// Canonical name for a flavor-specific tool id, or the input unchanged.
export function resolveToolNameAlias(toolName: string): string {
    return Object.hasOwn(TOOL_NAME_ALIASES, toolName) ? TOOL_NAME_ALIASES[toolName] : toolName
}