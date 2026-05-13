import { describe, expect, it } from 'vitest'
import { en, zhCN } from '@/lib/locales'
import type { ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import { formatGroupedHeaderSubtitle, formatGroupedHeaderTitle, formatGroupedRowLabel, inferGroupedSummaryIntent } from '@/components/ToolCard/groupedPresentation'

type Dict = Record<string, string>

function makeTranslator(dict: Dict) {
    return (key: string, params?: Record<string, string | number>) => {
        const template = dict[key] ?? key
        if (!params) return template
        return template.replace(/\{(\w+)\}/g, (match, token) => {
            const value = params[token]
            return value === undefined ? match : String(value)
        })
    }
}

function makeTool(id: string, name: string, input: unknown = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        invokedAt: null,
        tool: {
            id,
            name,
            state: 'completed',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: null,
            permission: undefined,
        },
        children: [],
    }
}

function makeGroup(tools: ToolCallBlock[]): ToolGroupBlock {
    return {
        kind: 'tool-group',
        id: 'tool-group:test',
        createdAt: 1,
        invokedAt: null,
        firstToolId: tools[0].id,
        lastToolId: tools[tools.length - 1].id,
        tools,
        defaultOpen: false,
        historyState: 'complete',
        needsOlderHistory: false,
        summary: {
            totalTools: tools.length,
            countsByKind: {
                read: tools.filter((tool) => tool.tool.name === 'Read').length,
                search: tools.filter((tool) => tool.tool.name === 'Grep' || tool.tool.name === 'Glob').length,
                command: tools.filter((tool) => tool.tool.name === 'Bash' || tool.tool.name === 'CodexBash' || tool.tool.name === 'shell_command').length,
                mutation: tools.filter((tool) => tool.tool.name === 'Edit' || tool.tool.name === 'Write' || tool.tool.name === 'MultiEdit').length,
                web: tools.filter((tool) => tool.tool.name === 'WebFetch' || tool.tool.name === 'WebSearch').length,
                other: 0,
            },
            fileTargets: [],
            commandTargets: [],
            searchTargets: [],
            urlTargets: [],
            otherTargets: [],
            errorCount: 0,
            runningCount: 0,
            pendingCount: 0,
        },
    }
}

const tEn = makeTranslator(en as Dict)
const tZh = makeTranslator(zhCN as Dict)

describe('inferGroupedSummaryIntent', () => {
    it('treats file inspection shell commands as inspect-files intent', () => {
        const tool = makeTool('shell-1', 'shell_command', { command: 'Get-ChildItem src -Recurse' })
        expect(inferGroupedSummaryIntent(tool)).toBe('inspect-files')
    })

    it('treats content search shell commands as search-content intent', () => {
        const tool = makeTool('shell-2', 'Bash', { command: 'rg "TodoWrite" web/src' })
        expect(inferGroupedSummaryIntent(tool)).toBe('search-content')
    })
})

describe('formatGroupedRowLabel', () => {
    it('returns a friendly english label without leaking raw shell command text', () => {
        const tool = makeTool('shell-3', 'shell_command', { command: 'Get-ChildItem src -Recurse' })
        const label = formatGroupedRowLabel(tool, tEn)

        expect(label).toBe('Inspect project files')
        expect(label).not.toContain('Get-ChildItem')
        expect(label).not.toContain('src')
    })

    it('returns a friendly chinese label for command execution', () => {
        const tool = makeTool('shell-4', 'Bash', { command: 'bun run build:web' })
        expect(formatGroupedRowLabel(tool, tZh)).toBe('执行项目命令')
    })
})

describe('formatGroupedHeaderTitle', () => {
    it('adds a +n suffix for grouped file inspection activity', () => {
        const group = makeGroup([
            makeTool('shell-1', 'shell_command', { command: 'Get-ChildItem src -Recurse' }),
            makeTool('shell-2', 'shell_command', { command: 'Get-Content package.json' }),
            makeTool('shell-3', 'shell_command', { command: 'dir web' }),
            makeTool('shell-4', 'shell_command', { command: 'ls docs' }),
            makeTool('shell-5', 'shell_command', { command: 'cat README.md' }),
        ])

        expect(formatGroupedHeaderTitle(group, tZh)).toBe('检查项目文件 +4')
    })
})

describe('formatGroupedHeaderSubtitle', () => {
    it('keeps the aggregate counter line short and localized', () => {
        const group = makeGroup([
            makeTool('shell-1', 'shell_command', { command: 'bun run build:web' }),
            makeTool('shell-2', 'shell_command', { command: 'bun run test' }),
        ])

        expect(formatGroupedHeaderSubtitle(group, tEn)).toBe('Run 2')
        expect(formatGroupedHeaderSubtitle(group, tZh)).toBe('执行 2')
    })
})
