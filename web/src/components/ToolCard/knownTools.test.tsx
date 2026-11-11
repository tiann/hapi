import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { formatTerminalCommandTitle, getToolPresentation } from '@/components/ToolCard/knownTools'

describe('formatTerminalCommandTitle', () => {
    it.each([
        ['bun run test --watch', 'bun run test'],
        ['git status --short', 'git status'],
        ['rg -n "foo" web/src', 'rg'],
        ['sudo systemctl restart hapi', 'systemctl restart'],
        ['CI=1 env NODE_ENV=test npm run lint -- --fix', 'npm run lint'],
        ['/usr/bin/docker compose up -d', 'docker compose up'],
        ['git -C /tmp/repo status', 'git'],
        ['sudo -u root systemctl restart hapi', null],
        ['bun test && bun typecheck', null],
        ['', null],
    ])('formats %j as %j', (command, expected) => {
        expect(formatTerminalCommandTitle(command)).toBe(expected)
    })

    it.each(['Bash', 'CodexBash', 'shell_command', 'run_shell_command'])('uses the command fallback for %s', (toolName) => {
        const presentation = getToolPresentation({
            toolName,
            input: { command: 'git status --short' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('git status')
        expect(presentation.subtitle).toBe('git status --short')
    })

    it('keeps the agent description authoritative', () => {
        const presentation = getToolPresentation({
            toolName: 'Bash',
            input: { command: 'git status --short' },
            result: null,
            childrenCount: 0,
            description: 'Inspect repository status',
            metadata: null,
        })

        expect(presentation.title).toBe('Inspect repository status')
    })

    it('shortens a native title that only repeats the raw command', () => {
        const presentation = getToolPresentation({
            toolName: 'run_shell_command',
            input: { command: 'ls -la /tmp' },
            result: null,
            childrenCount: 0,
            description: 'ls -la /tmp',
            metadata: null,
        })

        expect(presentation.title).toBe('ls')
    })
})

describe('getToolPresentation — unknown tool semantic title + subtitle dedup', () => {
    it('routes shell-shaped unknown tools (Gemini ACP command-name card) to the terminal presentation', () => {
        const presentation = getToolPresentation({
            toolName: 'cat /tmp/hello.txt',
            input: { command: 'cat /tmp/hello.txt' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        // Formatted like the canonical Bash card: title is the executable, the full
        // command stays in the subtitle.
        expect(presentation.title).toBe('cat')
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

    it('uses a concise command title for run_shell_command', () => {
        const presentation = getToolPresentation({
            toolName: 'run_shell_command',
            input: { command: 'ls -la /tmp' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('ls')
        expect(presentation.subtitle).toBe('ls -la /tmp')
    })

    it('uses input.name as a fallback subtitle for unknown tool cards', () => {
        const presentation = getToolPresentation({
            toolName: 'Tool',
            input: { name: 'Tool 1' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Tool')
        expect(presentation.subtitle).toBe('Tool 1')
        const icon = render(<>{presentation.icon}</>).container.querySelector('svg')
        expect(icon).toHaveClass('translate-y-px')
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
        expect(presentation.subtitle).toBe('effort medium · Reading file: README.md')
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
        expect(presentation.subtitle).toBe('effort low')
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

        expect(presentation.subtitle).toBe('effort low · Command finished: bun test')
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

    it('presents MultiAgent V2 messaging tools by intent', () => {
        const message = getToolPresentation({
            toolName: 'send_message',
            input: { target: '/root/review', message: 'Status?' },
            result: '',
            childrenCount: 0,
            description: null,
            metadata: null,
        })
        const followup = getToolPresentation({
            toolName: 'followup_task',
            input: { target: '/root/review', message: 'Run tests' },
            result: '',
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(message).toMatchObject({ title: 'Message agent', subtitle: '/root/review', minimal: true })
        expect(followup).toMatchObject({ title: 'Follow up agent', subtitle: '/root/review', minimal: true })
    })

    it('summarizes list_agents and interrupt_agent results', () => {
        const list = getToolPresentation({
            toolName: 'list_agents',
            input: {},
            result: JSON.stringify({
                agents: [
                    { agent_name: '/root/a', agent_status: 'running' },
                    { agent_name: '/root/b', agent_status: { completed: 'done' } }
                ]
            }),
            childrenCount: 0,
            description: null,
            metadata: null,
        })
        const interrupt = getToolPresentation({
            toolName: 'interrupt_agent',
            input: { target: '/root/a' },
            result: '{"previous_status":"running"}',
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(list).toMatchObject({ title: 'List agents', subtitle: '2 live, 1 running' })
        expect(interrupt).toMatchObject({ title: 'Interrupt agent', subtitle: 'Interrupted (running)' })
    })

    it('uses MultiAgent V2 result fields and status variants', () => {
        const spawn = getToolPresentation({
            toolName: 'spawn_agent',
            input: { task_name: 'review' },
            result: JSON.stringify({ task_name: '/root/review', nickname: 'Reviewer' }),
            childrenCount: 0,
            description: null,
            metadata: null,
        })
        const wait = getToolPresentation({
            toolName: 'wait_agent',
            input: { timeout_ms: 1000 },
            result: JSON.stringify({ message: 'Wait completed.', timed_out: false }),
            childrenCount: 0,
            description: null,
            metadata: null,
        })
        const list = getToolPresentation({
            toolName: 'list_agents',
            input: {},
            result: JSON.stringify({
                agents: [{ agent_name: '/root/review', agent_status: { errored: 'test failed' } }]
            }),
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(spawn.subtitle).toBe('Launched Reviewer (/root/review)')
        expect(wait.subtitle).toBe('Wait completed.')
        expect(list.subtitle).toBe('1 live agent')
    })
})

describe('getToolPresentation — native titles', () => {
    it('uses a preserved native title for unknown lowercase tools', () => {
        const presentation = getToolPresentation({
            toolName: 'bash',
            input: { command: 'bun test' },
            result: null,
            childrenCount: 0,
            description: 'Run project tests',
            metadata: null,
        })

        expect(presentation.title).toBe('Run project tests')
        expect(presentation.subtitle).toBe('bun test')
    })

    it('keeps the exact-name Bash presentation unchanged (regression)', () => {
        const presentation = getToolPresentation({
            toolName: 'Bash',
            input: { command: 'bun test' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('bun test')
        // The formatted command already is the title; no duplicated subtitle.
        expect(presentation.subtitle).toBeNull()
    })

    it('still resolves the v1 lowercase read alias to its own entry', () => {
        const presentation = getToolPresentation({
            toolName: 'read',
            input: { filePath: 'src/a.ts' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('src/a.ts')
    })
})

describe('getToolPresentation — OpenCode lowercase aliases', () => {
    function expectNotGenericWrench(presentation: { icon: ReactNode }): void {
        const icon = render(<>{presentation.icon}</>).container.querySelector('svg')
        // The generic fallback renders a wrench with a translate-y-px nudge;
        // resolved canonical cards use their own icons without it.
        expect(icon).not.toBeNull()
        expect(icon?.className).not.toContain('translate-y-px')
    }

    it('renders the OpenCode bash card like the canonical Bash card', () => {
        const presentation = getToolPresentation({
            toolName: 'bash',
            input: { command: 'ls -la /tmp', description: 'List files in /tmp' },
            result: null,
            childrenCount: 0,
            // OpenCode v2 echoes the tool id as the ACP title (nativeTitle).
            description: 'bash',
            metadata: null,
        })

        // input.description wins over a description that merely repeats the tool name.
        expect(presentation.title).toBe('List files in /tmp')
        expect(presentation.subtitle).toBe('ls -la /tmp')
        expect(presentation.minimal).toBe(true)
        expectNotGenericWrench(presentation)
    })

    it('falls back to the command when the OpenCode bash call carries no description', () => {
        const presentation = getToolPresentation({
            toolName: 'bash',
            input: { command: 'bun test' },
            result: null,
            childrenCount: 0,
            description: 'bash',
            metadata: null,
        })

        expect(presentation.title).toBe('bun test')
        expect(presentation.subtitle).toBeNull()
    })

    it('promotes a semantic title when the native title echoes an unformattable command', () => {
        const presentation = getToolPresentation({
            toolName: 'bash',
            input: { command: 'grep -rn "x" src | head -8' },
            result: null,
            childrenCount: 0,
            // OpenCode running updates carry the raw command as the ACP title.
            description: 'grep -rn "x" src | head -8',
            metadata: null,
        })

        expect(presentation.title).toBe('Run shell')
        expect(presentation.subtitle).toBe('grep -rn "x" src | head -8')
    })

    it('routes OpenCode command-name cards to the terminal presentation', () => {
        // OpenCode v2 running updates title the call after the raw command, so
        // the final card name is "ls", not "bash" — it never matches the alias
        // table and must still get the Bash card treatment.
        const presentation = getToolPresentation({
            toolName: 'ls',
            input: { command: 'ls', description: 'List demo files', cwd: '/workspace/demo-repo' },
            result: null,
            childrenCount: 0,
            description: 'ls',
            metadata: null,
        })

        expect(presentation.title).toBe('List demo files')
        expect(presentation.subtitle).toBe('ls')
        expect(presentation.minimal).toBe(true)
        expectNotGenericWrench(presentation)
    })

    it('drops the repeated native title from command-name cards without a description', () => {
        const presentation = getToolPresentation({
            toolName: 'bun test',
            input: { command: 'bun test' },
            result: null,
            childrenCount: 0,
            description: 'bun test',
            metadata: null,
        })

        expect(presentation.title).toBe('bun test')
        expect(presentation.subtitle).toBeNull()
    })

    it('keeps a meaningful ACP title over the command formatting', () => {
        const presentation = getToolPresentation({
            toolName: 'bash',
            input: { command: 'bun test' },
            result: null,
            childrenCount: 0,
            description: 'Run project tests',
            metadata: null,
        })

        expect(presentation.title).toBe('Run project tests')
    })

    it('maps webfetch to the WebFetch presentation', () => {
        const presentation = getToolPresentation({
            toolName: 'webfetch',
            input: { url: 'https://example.com/docs' },
            result: null,
            childrenCount: 0,
            description: 'webfetch',
            metadata: null,
        })

        expect(presentation.title).toBe('example.com')
        expect(presentation.subtitle).toBe('https://example.com/docs')
        expectNotGenericWrench(presentation)
    })

    it('maps glob, grep and list to their search presentations', () => {
        const glob = getToolPresentation({
            toolName: 'glob', input: { pattern: '*.ts' }, result: null, childrenCount: 0, description: 'glob', metadata: null,
        })
        const grep = getToolPresentation({
            toolName: 'grep', input: { pattern: 'authToken' }, result: null, childrenCount: 0, description: 'grep', metadata: null,
        })
        const list = getToolPresentation({
            toolName: 'list', input: { path: 'web/src' }, result: null, childrenCount: 0, description: 'list', metadata: null,
        })

        expect(glob.title).toBe('*.ts')
        expect(grep.title).toBe('grep(pattern: authToken)')
        expect(list.title).toBe('web/src')
        expectNotGenericWrench(glob)
        expectNotGenericWrench(grep)
        expectNotGenericWrench(list)
    })

    it('maps write and edit to the file mutation presentations', () => {
        const write = getToolPresentation({
            toolName: 'write', input: { file_path: 'src/a.ts', content: 'export {}' }, result: null, childrenCount: 0, description: 'write', metadata: null,
        })
        const edit = getToolPresentation({
            toolName: 'edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, result: null, childrenCount: 0, description: 'edit', metadata: null,
        })

        expect(write.title).toBe('src/a.ts')
        expect(write.subtitle).toBe('9 chars')
        expect(edit.title).toBe('src/a.ts')
        expectNotGenericWrench(write)
        expectNotGenericWrench(edit)
    })

    it('maps task to the Task presentation', () => {
        const presentation = getToolPresentation({
            toolName: 'task',
            input: { description: 'Explore', prompt: 'find null tool input' },
            result: null,
            childrenCount: 0,
            description: 'task',
            metadata: null,
        })

        expect(presentation.title).toBe('Explore')
        expect(presentation.subtitle).toBe('find null tool input')
        expectNotGenericWrench(presentation)
    })

    it('localizes the semantic run-shell fallback', () => {
        const presentation = getToolPresentation({
            toolName: 'bash',
            input: { command: 'grep -rn "x" src | head -8' },
            result: null,
            childrenCount: 0,
            description: 'grep -rn "x" src | head -8',
            metadata: null,
        }, (key) => (key === 'tool.semanticTitle.runShell' ? '运行命令' : key))

        expect(presentation.title).toBe('运行命令')
    })
})

describe('getToolPresentation — request_user_input', () => {
    it('uses the question header instead of exposing its protocol id', () => {
        const presentation = getToolPresentation({
            toolName: 'request_user_input',
            input: {
                questions: [{
                    id: '__mcp_url_confirmation',
                    header: 'Sign in',
                    question: 'Sign in to continue'
                }]
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Sign in')
        expect(presentation.title).not.toContain('__mcp_url_confirmation')
        expect(presentation.subtitle).toBe('Sign in to continue')
    })

    it('falls back to Question rather than exposing an id when no header is present', () => {
        const presentation = getToolPresentation({
            toolName: 'request_user_input',
            input: {
                questions: [{
                    id: '__mcp_form_confirmation',
                    question: 'Continue?'
                }]
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Question')
        expect(presentation.subtitle).toBe('Continue?')
    })
})
