import { describe, expect, it } from 'vitest'
import { getToolPresentation } from '@/components/ToolCard/knownTools'

describe('getToolPresentation — unknown tool semantic title + subtitle dedup', () => {
    it('promotes semantic title "Run shell" when toolName equals input.command (Gemini ACP case)', () => {
        const presentation = getToolPresentation({
            toolName: 'cat /tmp/hello.txt',
            input: { command: 'cat /tmp/hello.txt' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Run shell')
        expect(presentation.subtitle).toBe('cat /tmp/hello.txt')
    })

    it('promotes semantic title "Read file" when toolName equals input.file_path', () => {
        const presentation = getToolPresentation({
            toolName: 'README.md',
            input: { file_path: 'README.md' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Read file')
        expect(presentation.subtitle).toBe('README.md')
    })

    it('promotes semantic title "Search" when toolName equals input.pattern', () => {
        const presentation = getToolPresentation({
            toolName: '*.ts',
            input: { pattern: '*.ts' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Search')
        expect(presentation.subtitle).toBe('*.ts')
    })

    it('keeps the original toolName when subtitle differs (no promotion needed)', () => {
        const presentation = getToolPresentation({
            toolName: 'run_shell_command',
            input: { command: 'ls -la /tmp' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('run_shell_command')
        expect(presentation.subtitle).toBe('ls -la /tmp')
    })

    it('returns null subtitle when no recognized input field is present', () => {
        const presentation = getToolPresentation({
            toolName: 'mystery_tool',
            input: { foo: 'bar' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('mystery_tool')
        expect(presentation.subtitle).toBeNull()
    })
})

describe('getToolPresentation — Codex agent tools', () => {
    it('titles CodexAgent cards from work summary instead of agent id', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexAgent',
            input: {
                agentId: 'agent-1234567890',
                summary: '检查 Hub Web README',
                activity: 'Reading file: README.md',
                reasoning_effort: 'medium'
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Agent: 检查 Hub Web README')
        expect(presentation.title).not.toContain('agent-1234567890')
        expect(presentation.subtitle).toBe('reasoning medium · Reading file: README.md')
        expect(presentation.minimal).toBe(true)
    })

    it('shows Codex auto-selected effort on CodexAgent cards even before activity is available', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexAgent',
            input: {
                summary: 'Inspect package metadata',
                reasoning_effort: 'low'
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Agent: Inspect package metadata')
        expect(presentation.subtitle).toBe('reasoning low')
    })

    it('does not present sub-operation completion as final agent completion while still running', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexAgent',
            input: {
                summary: 'Inspect package metadata',
                agentStatus: 'running',
                activity: 'Command completed: bun test',
                reasoning_effort: 'low'
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.subtitle).toBe('reasoning low · Command finished: bun test')
    })

    it('falls back to prompt-derived CodexAgent titles without exposing agent id', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexAgent',
            input: {
                agentId: 'agent-1234567890',
                message: 'Fix the reducer for live agent cards.\nDo not revert other changes.'
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Agent: Fix the reducer for live agent cards.')
        expect(presentation.title).not.toContain('agent-1234567890')
    })

    it('summarizes spawn_agent with the spawned agent id', () => {
        const presentation = getToolPresentation({
            toolName: 'spawn_agent',
            input: {
                agent_type: 'worker',
                message: 'Implement the parser'
            },
            result: '{"agent_id":"agent-123","nickname":"Raman"}',
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Spawn worker agent')
        expect(presentation.subtitle).toBe('Launched Raman (agent-123)')
        expect(presentation.minimal).toBe(true)
    })

    it('summarizes wait_agent status counts', () => {
        const presentation = getToolPresentation({
            toolName: 'wait_agent',
            input: {
                targets: ['a', 'b'],
                timeout_ms: 30000
            },
            result: '{"status":{"a":{"completed":"done"},"b":{"failed":"boom"}},"timed_out":false}',
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Wait for 2 agents')
        expect(presentation.subtitle).toBe('1 completed, 1 non-completed')
        expect(presentation.minimal).toBe(true)
    })

    it('does not expose close_agent previous output in the collapsed subtitle', () => {
        const presentation = getToolPresentation({
            toolName: 'close_agent',
            input: {
                target: 'agent-123'
            },
            result: '{"previous_status":{"completed":"hidden child output"}}',
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Close agent')
        expect(presentation.subtitle).toBe('Closed (completed)')
        expect(presentation.subtitle).not.toContain('hidden child output')
        expect(presentation.minimal).toBe(true)
    })
})
