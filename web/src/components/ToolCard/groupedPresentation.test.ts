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
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result: null,
            permission: undefined,
        },
        children: [],
    }
}

function makeGroup(tools: ToolCallBlock[]): ToolGroupBlock {
    const read = tools.filter((tool) => tool.tool.name === 'Read').length
    const search = tools.filter((tool) => tool.tool.name === 'Grep' || tool.tool.name === 'Glob').length
    const command = tools.filter((tool) => tool.tool.name === 'Bash' || tool.tool.name === 'CodexBash' || tool.tool.name === 'shell_command').length
    const mutation = tools.filter((tool) => tool.tool.name === 'Edit' || tool.tool.name === 'Write' || tool.tool.name === 'MultiEdit').length
    const web = tools.filter((tool) => tool.tool.name === 'WebFetch' || tool.tool.name === 'WebSearch').length

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
                read,
                search,
                command,
                mutation,
                web,
                other: tools.length - read - search - command - mutation - web,
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
    it('uses an immediately preceding Codex activity heading', () => {
        const group = makeGroup([
            makeTool('read-activity-1', 'Read', { file_path: 'auth.ts' }),
            makeTool('read-activity-2', 'Read', { file_path: 'session.ts' }),
        ])
        group.activityTitle = 'Inspecting the authentication flow'

        expect(formatGroupedHeaderTitle(group, tEn)).toBe('Inspecting the authentication flow')
    })

    it('uses a specific file target instead of the generic inspection label', () => {
        const group = makeGroup([
            makeTool('read-1', 'Read', { file_path: '/repo/src/auth.ts' }),
            makeTool('read-2', 'Read', { file_path: '/repo/src/session.ts' }),
        ])

        expect(formatGroupedHeaderTitle(group, tEn)).toBe('Inspect auth.ts')
    })

    it('uses a specific search pattern', () => {
        const group = makeGroup([
            makeTool('grep-1', 'Grep', { pattern: 'authToken' }),
            makeTool('grep-2', 'Grep', { pattern: 'authToken' }),
        ])

        expect(formatGroupedHeaderTitle(group, tEn)).toBe('Search “authToken”')
    })

    it('extracts safe targets from Codex inspection and search commands', () => {
        const inspect = makeGroup([
            makeTool('inspect-command-1', 'shell_command', { command: "sed -n '1,120p' web/src/auth.ts" }),
            makeTool('inspect-command-2', 'shell_command', { command: 'cat web/src/session.ts' }),
        ])
        const search = makeGroup([
            makeTool('search-command-1', 'shell_command', { command: "rg 'authToken' web/src" }),
            makeTool('search-command-2', 'shell_command', { command: "grep 'authToken' cli/src/index.ts" }),
        ])

        expect(formatGroupedHeaderTitle(inspect, tEn)).toBe('Inspect auth.ts')
        expect(formatGroupedHeaderTitle(search, tEn)).toBe('Search “authToken”')
    })

    it('skips search option values and redacts common token prefixes', () => {
        const optioned = makeGroup([
            makeTool('search-option-1', 'shell_command', { command: "rg -g '*.ts' authToken web/src" }),
            makeTool('search-option-2', 'shell_command', { command: "grep -m 2 authToken cli/src" }),
        ])
        const credential = makeGroup([
            makeTool('search-secret-1', 'Grep', { pattern: 'ghp_1234567890abcdefghijklmnop' }),
            makeTool('search-secret-2', 'Grep', { pattern: 'ghp_1234567890abcdefghijklmnop' }),
        ])

        expect(formatGroupedHeaderTitle(optioned, tEn)).toBe('Search “authToken”')
        expect(formatGroupedHeaderTitle(credential, tEn)).toBe('Search project content')
        expect(formatGroupedHeaderTitle(credential, tEn)).not.toContain('ghp_')
    })

    it('uses a safe project command but hides arbitrary command text', () => {
        const safe = makeGroup([
            makeTool('cmd-1', 'Bash', { command: 'bun test' }),
            makeTool('cmd-2', 'Bash', { command: 'bun test' }),
        ])
        const sensitive = makeGroup([
            makeTool('cmd-3', 'Bash', { command: 'curl -H "Authorization: Bearer abc" example.com' }),
            makeTool('cmd-4', 'Bash', { command: 'curl example.com' }),
        ])

        expect(formatGroupedHeaderTitle(safe, tEn)).toBe('Run bun test')
        expect(formatGroupedHeaderTitle(sensitive, tEn)).toBe('Run project commands')
        expect(formatGroupedHeaderTitle(sensitive, tEn)).not.toContain('Bearer')
    })

    it('prefers a Claude call description and truncates long labels', () => {
        const first = makeTool('cmd-description-1', 'Bash', { command: 'node script.js' })
        first.tool.description = 'Check the authentication migration behavior before applying changes'
        const second = makeTool('cmd-description-2', 'Bash', { command: 'node other.js' })
        const group = makeGroup([first, second])

        expect(formatGroupedHeaderTitle(group, tEn)).toBe('Check the authentication migration behavior before applying changes')
    })

    it('uses the primary activity without an inline +n suffix', () => {
        const group = makeGroup([
            makeTool('shell-1', 'shell_command', { command: 'Get-ChildItem src -Recurse' }),
            makeTool('shell-2', 'shell_command', { command: 'Get-Content package.json' }),
            makeTool('shell-3', 'shell_command', { command: 'dir web' }),
            makeTool('shell-4', 'shell_command', { command: 'ls docs' }),
            makeTool('shell-5', 'shell_command', { command: 'cat README.md' }),
        ])

        expect(formatGroupedHeaderTitle(group, tZh)).toBe('检查 src')
    })

    it('uses a neutral title for all-generic tool groups', () => {
        const group = makeGroup([
            makeTool('tool-1', 'Tool', { name: 'Tool 1' }),
            makeTool('tool-2', 'Tool', { name: 'Tool 2' }),
        ])

        expect(formatGroupedHeaderTitle(group, tEn)).toBe('Tool activity')
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

    it('omits the aggregate counter line for all-generic tool groups', () => {
        const group = makeGroup([
            makeTool('tool-1', 'Tool', { name: 'Tool 1' }),
            makeTool('tool-2', 'Tool', { name: 'Tool 2' }),
        ])

        expect(formatGroupedHeaderSubtitle(group, tEn)).toBeNull()
    })
})
