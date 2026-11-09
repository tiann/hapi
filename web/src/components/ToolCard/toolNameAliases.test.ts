import { describe, expect, it } from 'vitest'
import { resolveToolNameAlias, TOOL_NAME_ALIASES } from './toolNameAliases'
import { knownTools } from './knownTools'
import { toolResultViewRegistry } from './views/_results'

describe('TOOL_NAME_ALIASES', () => {
    it('maps every alias to a registered presentation and result view', () => {
        for (const [alias, canonical] of Object.entries(TOOL_NAME_ALIASES)) {
            expect(knownTools[canonical], `${alias} -> ${canonical} presentation`).toBeDefined()
            expect(toolResultViewRegistry[canonical], `${alias} -> ${canonical} result view`).toBeDefined()
        }
    })

    it('leaves exact names and unknown tools unchanged', () => {
        expect(resolveToolNameAlias('Bash')).toBe('Bash')
        expect(resolveToolNameAlias('CodexBash')).toBe('CodexBash')
        // 'read' is a real registry key (OpenCode v1), not an alias.
        expect(resolveToolNameAlias('read')).toBe('read')
        expect(resolveToolNameAlias('mcp__server__tool')).toBe('mcp__server__tool')
        expect(resolveToolNameAlias('some_unknown_tool')).toBe('some_unknown_tool')
    })
})