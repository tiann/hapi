/**
 * Tests for Trace section in ToolCard dialog.
 * Verifies that Task tool modals expose child tool call traces.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ToolCallBlock } from '@/chat/types'
import { TraceSection, getTaskTraceChildren, getTraceSummaryText } from '@/components/ToolCard/trace'

// useTranslation returns a simple key-passthrough stub for tests
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => {
            const map: Record<string, string> = {
                'tool.trace': 'Trace',
                'tool.trace.callsSuffix': 'calls',
                'tool.input': 'Input',
                'tool.result': 'Result',
            }
            return map[key] ?? key
        },
    }),
}))

// getToolFullViewComponent returns null by default (no special view for generic tools)
vi.mock('@/components/ToolCard/views/_all', () => ({
    getToolFullViewComponent: () => null,
}))

// CodeBlock renders a simple pre element
vi.mock('@/components/CodeBlock', () => ({
    CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

// safeStringify from @hapi/protocol
vi.mock('@hapi/protocol', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@hapi/protocol')>()
    return {
        ...actual,
        safeStringify: (v: unknown) => JSON.stringify(v),
    }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChild(
    id: string,
    name: string,
    state: ToolCallBlock['tool']['state'] = 'completed',
): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1000,
        tool: {
            id,
            name,
            state,
            input: { path: `file-${id}.ts` },
            createdAt: 1000,
            startedAt: 1000,
            completedAt: 2000,
            description: null,
            result: null,
        },
        children: [],
    }
}

function makeTaskBlock(
    children: ToolCallBlock[],
    state: ToolCallBlock['tool']['state'] = 'completed',
    result: unknown = null,
): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'task-1',
        localId: null,
        createdAt: 1000,
        tool: {
            id: 'task-1',
            name: 'Task',
            state,
            input: { prompt: 'do stuff', subagent_type: 'Explore' },
            createdAt: 1000,
            startedAt: 1000,
            completedAt: 2000,
            description: null,
            result,
        },
        children,
    }
}

function makeCodexAgentBlock(
    children: ToolCallBlock[],
    state: ToolCallBlock['tool']['state'] = 'completed',
    result: unknown = 'done',
): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'agent-1',
        localId: null,
        createdAt: 1000,
        tool: {
            id: 'agent-1',
            name: 'CodexAgent',
            state,
            input: { message: 'inspect repo', agentId: 'subagent-1' },
            createdAt: 1000,
            startedAt: 1000,
            completedAt: 2000,
            description: null,
            result,
        },
        children,
    }
}

function makeAgentBlock(
    children: ToolCallBlock[],
    state: ToolCallBlock['tool']['state'] = 'completed',
    result: unknown = null,
): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'agent-1',
        localId: null,
        createdAt: 1000,
        tool: {
            id: 'agent-1',
            name: 'Agent',
            state,
            input: { prompt: 'do stuff', subagent_type: 'general-purpose' },
            createdAt: 1000,
            startedAt: 1000,
            completedAt: 2000,
            description: null,
            result,
        },
        children,
    }
}

// ---------------------------------------------------------------------------
// getTaskTraceChildren
// ---------------------------------------------------------------------------

describe('getTaskTraceChildren', () => {
    it('returns null when there are no tool-call children', () => {
        const block = makeTaskBlock([])
        expect(getTaskTraceChildren(block)).toBeNull()
    })

    it('returns all tool-call children', () => {
        const block = makeTaskBlock([
            makeChild('c1', 'Glob'),
            makeChild('c2', 'Grep'),
            makeChild('c3', 'Read'),
        ])
        const result = getTaskTraceChildren(block)
        expect(result).not.toBeNull()
        expect(result!.length).toBe(3)
    })

    it('filters out non-tool-call children', () => {
        const block: ToolCallBlock = {
            ...makeTaskBlock([makeChild('c1', 'Glob')]),
            children: [
                makeChild('c1', 'Glob'),
                { kind: 'agent-text', id: 'txt-1', localId: null, createdAt: 0, text: 'hi' },
            ],
        }
        const result = getTaskTraceChildren(block)
        expect(result!.length).toBe(1)
    })

    // Fix #2: non-Task blocks must return null
    it('returns null for non-Task blocks', () => {
        const block: ToolCallBlock = {
            ...makeTaskBlock([makeChild('c1', 'Glob')]),
            tool: {
                ...makeTaskBlock([makeChild('c1', 'Glob')]).tool,
                name: 'Bash',
            },
        }
        expect(getTaskTraceChildren(block)).toBeNull()
    })

    // Agent tool name (new SDK name for subagent invocations)
    it('returns children for Agent blocks (same as Task)', () => {
        const block = makeAgentBlock([
            makeChild('c1', 'Glob'),
            makeChild('c2', 'Grep'),
        ])
        const result = getTaskTraceChildren(block)
        expect(result).not.toBeNull()
        expect(result!.length).toBe(2)
    })

    it('returns null for Agent block with no tool-call children', () => {
        const block = makeAgentBlock([])
        expect(getTaskTraceChildren(block)).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// getTraceSummaryText
// ---------------------------------------------------------------------------

describe('getTraceSummaryText', () => {
    it('shows calls + tok + seconds when all data available', () => {
        const text = getTraceSummaryText(5, 25054, 11784, 'calls')
        expect(text).toBe('5 calls · 25.1k tok · 11.8s')
    })

    it('shows calls + seconds when tokens unavailable', () => {
        const text = getTraceSummaryText(3, null, 4200, 'calls')
        expect(text).toBe('3 calls · 4.2s')
    })

    it('shows only calls when both unavailable', () => {
        const text = getTraceSummaryText(2, null, null, 'calls')
        expect(text).toBe('2 calls')
    })
})

// ---------------------------------------------------------------------------
// TraceSection component
// ---------------------------------------------------------------------------

describe('TraceSection', () => {
    it('renders nothing when children is empty', () => {
        const block = makeTaskBlock([])
        const { container } = render(
            <TraceSection block={block} metadata={null} />
        )
        expect(container.firstChild).toBeNull()
    })

    it('renders Trace header when children exist', () => {
        const block = makeTaskBlock([makeChild('c1', 'Glob'), makeChild('c2', 'Grep')])
        render(<TraceSection block={block} metadata={null} />)
        expect(screen.getByText(/Trace/i)).toBeInTheDocument()
    })

    it('shows child rows when expanded (running)', () => {
        const block = makeTaskBlock([makeChild('c1', 'Glob'), makeChild('c2', 'Grep')], 'running')
        const { container } = render(<TraceSection block={block} metadata={null} />)
        // running → default open; child list rendered
        const childList = container.querySelector('.border-l')
        expect(childList).not.toBeNull()
        // 2 child toggle buttons present (data-testid free — query by aria-expanded absence)
        const allBtns = container.querySelectorAll('button')
        expect(allBtns.length).toBeGreaterThanOrEqual(3) // header + 2 children
    })

    it('is collapsed by default when task is completed', () => {
        const block = makeTaskBlock([makeChild('c1', 'Glob'), makeChild('c2', 'Grep')], 'completed')
        const { container } = render(<TraceSection block={block} metadata={null} />)
        // header button with aria-expanded=false
        const headerBtn = container.querySelector('button[aria-expanded="false"]')
        expect(headerBtn).not.toBeNull()
        // child list NOT rendered
        const childList = container.querySelector('.border-l')
        expect(childList).toBeNull()
    })

    it('is expanded by default when task is running', () => {
        const block = makeTaskBlock([makeChild('c1', 'Read')], 'running')
        const { container } = render(<TraceSection block={block} metadata={null} />)
        // header aria-expanded=true
        const headerBtn = container.querySelector('button[aria-expanded="true"]')
        expect(headerBtn).not.toBeNull()
        // child list rendered
        expect(container.querySelector('.border-l')).not.toBeNull()
    })

    it('is expanded by default when task is error', () => {
        const block = makeTaskBlock([makeChild('c1', 'Read', 'error')], 'error')
        const { container } = render(<TraceSection block={block} metadata={null} />)
        const headerBtn = container.querySelector('button[aria-expanded="true"]')
        expect(headerBtn).not.toBeNull()
    })

    it('toggles open/close on header click', () => {
        const block = makeTaskBlock([makeChild('c1', 'Glob')], 'completed')
        const { container } = render(<TraceSection block={block} metadata={null} />)
        // initially collapsed
        expect(container.querySelector('.border-l')).toBeNull()
        expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull()

        // click header to open
        const btn = container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement
        fireEvent.click(btn)
        expect(container.querySelector('.border-l')).not.toBeNull()
        expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull()

        // click again to close
        const btn2 = container.querySelector('button[aria-expanded="true"]') as HTMLButtonElement
        fireEvent.click(btn2)
        expect(container.querySelector('.border-l')).toBeNull()
    })

    it('displays summary text with call count', () => {
        const result = { totalToolUseCount: 3, totalTokens: 12400, totalDurationMs: 4200 }
        const block = makeTaskBlock([
            makeChild('c1', 'Glob'),
            makeChild('c2', 'Grep'),
            makeChild('c3', 'Read'),
        ], 'completed', result)
        render(<TraceSection block={block} metadata={null} />)
        // summary shown in header
        expect(screen.getByText(/3 calls/)).toBeInTheDocument()
    })

    it('shows Input section when a child row is expanded', () => {
        const block = makeTaskBlock([makeChild('c1', 'Bash')], 'running')
        const { container } = render(<TraceSection block={block} metadata={null} />)

        // child list visible (running → default open)
        const childBtns = container.querySelectorAll('.border-l button')
        expect(childBtns.length).toBeGreaterThanOrEqual(1)

        // click the child row to expand it
        fireEvent.click(childBtns[0])

        // Input section label must be present in the expanded box
        expect(screen.getByText('Input')).toBeInTheDocument()
        // Result section label must also be present
        expect(screen.getByText('Result')).toBeInTheDocument()
    })

    it('opens CodexAgent trace by default but leaves child rows collapsed', () => {
        const block = makeCodexAgentBlock([makeChild('c1', 'Bash'), makeChild('c2', 'Read')], 'completed')
        const { container } = render(<TraceSection block={block} metadata={null} />)

        expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull()
        expect(container.querySelector('.border-l')).toBeNull()
        expect(container.textContent).toContain('Terminal')
        expect(container.textContent).toContain('file-c2.ts')
        expect(container.textContent).not.toContain('Input')
        expect(container.textContent).not.toContain('Result')

        const childButtons = Array.from(container.querySelectorAll('button'))
            .filter((button) => button.getAttribute('aria-expanded') === null)
        expect(childButtons).toHaveLength(2)

        fireEvent.click(childButtons[0])
        expect(container.textContent).toContain('Input')
        expect(container.textContent).toContain('Result')
    })

    // Agent tool name — same Trace UX as Task
    it('renders Trace header for Agent blocks', () => {
        const block = makeAgentBlock([makeChild('c1', 'Glob'), makeChild('c2', 'Grep')])
        const { container } = render(<TraceSection block={block} metadata={null} />)
        // TraceSection must mount (non-null) for Agent blocks
        expect(container.firstChild).not.toBeNull()
        // header button with aria-expanded attribute must exist
        const btn = container.querySelector('button[aria-expanded]')
        expect(btn).not.toBeNull()
    })

    it('renders nothing for Agent block with no children', () => {
        const block = makeAgentBlock([])
        const { container } = render(<TraceSection block={block} metadata={null} />)
        expect(container.firstChild).toBeNull()
    })

    it('expands Agent trace by default when running', () => {
        const block = makeAgentBlock([makeChild('c1', 'Read')], 'running')
        const { container } = render(<TraceSection block={block} metadata={null} />)
        const headerBtn = container.querySelector('button[aria-expanded="true"]')
        expect(headerBtn).not.toBeNull()
        expect(container.querySelector('.border-l')).not.toBeNull()
    })
})
