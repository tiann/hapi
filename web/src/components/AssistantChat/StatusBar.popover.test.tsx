import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

describe('StatusBar context details dialog', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('keeps stable connection labels in English and offsets the whole left status', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        const { rerender } = render(
            <I18nProvider>
                <StatusBar active thinking={false} agentState={null} />
            </I18nProvider>
        )

        const onlineLabel = screen.getByText('online')
        expect(onlineLabel.className.split(' ')).not.toContain('top-px')
        expect(onlineLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(onlineLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(onlineLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')

        rerender(
            <I18nProvider>
                <StatusBar active={false} thinking={false} agentState={null} />
            </I18nProvider>
        )

        const offlineLabel = screen.getByText('offline')
        expect(offlineLabel.className.split(' ')).toContain('text-[#999]')
        expect(offlineLabel.className.split(' ')).not.toContain('top-px')
        expect(offlineLabel.previousElementSibling?.className.split(' ')).toContain('bg-[#999]')
        expect(offlineLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(offlineLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(offlineLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')

        rerender(
            <I18nProvider>
                <StatusBar active thinking agentState={null} />
            </I18nProvider>
        )

        const thinkingLabel = screen.getByText(/…$/)
        expect(thinkingLabel.className.split(' ')).not.toContain('top-px')
        expect(thinkingLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(thinkingLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(thinkingLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')
    })

    it('keeps the connection state in the agent-details accessible name', () => {
        localStorage.setItem('hapi-lang', 'en')
        const { rerender } = render(
            <I18nProvider>
                <StatusBar active thinking={false} agentState={null} />
            </I18nProvider>
        )

        expect(screen.getByRole('button', { name: 'Agent context details: online' })).toBeInTheDocument()

        rerender(
            <I18nProvider>
                <StatusBar active={false} thinking={false} agentState={null} />
            </I18nProvider>
        )

        expect(screen.getByRole('button', { name: 'Agent context details: offline' })).toBeInTheDocument()
    })

    it('uses an effort-only reasoning label on mobile and the full label on desktop', () => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="codex"
                    modelReasoningEffort="xhigh"
                    effort="max"
                />
            </I18nProvider>
        )

        expect(screen.getByText('xhigh').className.split(' ')).toContain('sm:hidden')
        const desktopLabel = screen.getByText('reasoning xhigh')
        expect(desktopLabel.className.split(' ')).toContain('hidden')
        expect(desktopLabel.className.split(' ')).toContain('sm:inline')
    })

    it('keeps the Codex default reasoning label when model effort is absent', () => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="codex"
                    modelReasoningEffort={null}
                />
            </I18nProvider>
        )

        expect(screen.getByText('default').className.split(' ')).toContain('sm:hidden')
        expect(screen.getByText('reasoning default').className.split(' ')).toContain('sm:inline')
    })

    it('uses Pi ordinary effort instead of model reasoning effort', () => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="pi"
                    modelReasoningEffort="xhigh"
                    effort="max"
                />
            </I18nProvider>
        )

        expect(screen.getByText('max').className.split(' ')).toContain('sm:hidden')
        expect(screen.getByText('reasoning max').className.split(' ')).toContain('sm:inline')
        expect(screen.queryByText('reasoning xhigh')).not.toBeInTheDocument()
    })

    it('hides Pi reasoning when effort is absent or blank', () => {
        const { rerender } = render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="pi"
                />
            </I18nProvider>
        )

        expect(screen.queryByText('reasoning default')).not.toBeInTheDocument()
        expect(screen.queryByText('default')).not.toBeInTheDocument()

        rerender(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="pi"
                    effort="   "
                />
            </I18nProvider>
        )

        expect(screen.queryByText('reasoning default')).not.toBeInTheDocument()
        expect(screen.queryByText('default')).not.toBeInTheDocument()
    })

    it('does not expose ordinary effort for Claude or unknown flavors', () => {
        const { rerender } = render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="claude"
                    effort="max"
                />
            </I18nProvider>
        )

        expect(screen.queryByText('reasoning max')).not.toBeInTheDocument()
        expect(screen.queryByText('max')).not.toBeInTheDocument()

        rerender(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="unknown"
                    effort="max"
                />
            </I18nProvider>
        )

        expect(screen.queryByText('reasoning max')).not.toBeInTheDocument()
        expect(screen.queryByText('max')).not.toBeInTheDocument()
    })

    it('opens from the mobile-accessible context trigger and keeps the requested detail order', async () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    contextSize={90_000}
                    contextCacheRead={86_000}
                    contextWindow={258_000}
                />
            </I18nProvider>
        )

        const connectionLabel = screen.getByText('online')
        const leftStatusGroup = connectionLabel.parentElement?.parentElement
        const statusBar = leftStatusGroup?.parentElement
        const rightStatusGroup = statusBar?.lastElementChild
        expect(statusBar?.className.split(' ')).toContain('items-baseline')
        expect(leftStatusGroup?.className.split(' ')).toContain('items-baseline')
        expect(rightStatusGroup?.className.split(' ')).toContain('items-baseline')
        expect(connectionLabel.className.split(' ')).not.toContain('top-px')
        expect(connectionLabel.previousElementSibling?.className.split(' ')).not.toContain('top-px')
        expect(connectionLabel.parentElement?.className.split(' ')).toContain('top-px')
        expect(connectionLabel.parentElement?.className.split(' ')).toContain('sm:top-0.5')
        expect(leftStatusGroup?.className.split(' ')).toContain('gap-2')
        expect(leftStatusGroup?.className.split(' ')).not.toContain('sm:gap-3')
        expect(rightStatusGroup?.className.split(' ')).toContain('gap-2')

        const trigger = screen.getByRole('button', { name: '上下文详情' })
        expect(trigger.className.split(' ')).not.toContain('relative')
        expect(trigger.className.split(' ')).not.toContain('-top-px')
        expect(trigger.className.split(' ')).toContain('text-[10px]')
        expect(trigger.className.split(' ')).toContain('leading-4')
        expect(trigger.className.split(' ')).toContain('text-[var(--app-hint)]')
        expect(trigger.textContent).toBe('ctx 258k (65% left)35% · 90k / 258k')
        expect(trigger.className.split(' ')).not.toContain('hidden')
        const progressTrack = trigger.querySelector('[aria-hidden="true"]')
        expect((progressTrack?.firstElementChild as HTMLElement | null)?.style.width).toBe('35%')

        fireEvent.click(trigger)

        const cacheLine = await screen.findByText('缓存：86k')
        const details = cacheLine.parentElement
        expect(details?.textContent).toBe('缓存：86k使用：90k（35%）剩余：168k（65%）')
        expect(screen.queryByRole('heading', { name: '上下文详情' })).not.toBeInTheDocument()
    })

    it('localizes the popover content without localizing the external left label', async () => {
        localStorage.setItem('hapi-lang', 'en')
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    contextSize={90_000}
                    contextCacheRead={86_000}
                    contextWindow={258_000}
                />
            </I18nProvider>
        )

        const trigger = screen.getByRole('button', { name: 'Context details' })
        expect(trigger.textContent).toContain('ctx 258k (65% left)')

        fireEvent.click(trigger)

        const cacheLine = await screen.findByText('Cache: 86k')
        expect(cacheLine.parentElement?.textContent).toBe('Cache: 86kUsed: 90k (35%)Remaining: 168k (65%)')
    })

    it('renders Claude system tools, slash commands, and skills from the agent status entry', async () => {
        localStorage.setItem('hapi-lang', 'en')
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="claude"
                    contextSize={26_697}
                    contextWindow={262_144}
                    contextDetails={{
                        version: 1,
                        updatedAt: 100,
                        provider: 'claude',
                        model: 'claude-sonnet',
                        contextWindow: 262_144,
                        usage: { contextTokens: 26_697 },
                        claude: {
                            skills: [{ name: 'find-docs' }],
                            mcpTools: [{ name: 'mcp__hapi__list_peers', serverName: 'hapi' }],
                            systemTools: ['Read', 'Bash'],
                            slashCommands: ['/context', '/compact'],
                        }
                    }}
                />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /Agent context details/ }))

        expect(screen.getByRole('heading', { name: 'Agent details' })).toBeInTheDocument()
        const dialog = screen.getByRole('dialog')
        expect(dialog.className.split(' ')).toContain('overflow-hidden')
        expect(dialog.querySelector('.agent-details-scroll-y')?.className.split(' ')).toEqual(
            expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto'])
        )
        expect(screen.getByRole('dialog').className.split(' ')).toEqual(expect.arrayContaining(['px-2', 'py-4']))
        expect(screen.getByRole('dialog').style.paddingBottom).toBe('')
        expect(screen.getByRole('button', { name: 'Close' }).className.split(' ')).toEqual(
            expect.arrayContaining(['top-2', 'z-20'])
        )
        expect(screen.getByRole('heading', { name: 'Agent details' }).parentElement?.className.split(' ')).toEqual(
            expect.arrayContaining(['items-center', 'bg-[var(--app-dialog-bg)]', 'pb-4', 'pr-0', 'text-center', 'sm:text-center'])
        )
        expect(screen.queryByText('Claude')).not.toBeInTheDocument()
        expect(screen.queryByText('claude-sonnet')).not.toBeInTheDocument()
        expect(screen.getByText('System tools')).toBeInTheDocument()
        expect(screen.getByText('Read')).toBeInTheDocument()
        expect(screen.getByText('Bash')).toBeInTheDocument()
        expect(screen.getByText('Agent commands')).toBeInTheDocument()
        expect(screen.getByText('/context')).toBeInTheDocument()
        expect(screen.getByText('/compact')).toBeInTheDocument()
        expect(screen.getByText('Skills')).toBeInTheDocument()
        expect(screen.getByText(/find-docs/)).toBeInTheDocument()
        expect(screen.queryByText('Find docs')).not.toBeInTheDocument()
        expect(screen.getByText('MCP tools')).toBeInTheDocument()
        expect(screen.getByText('mcp__hapi__list_peers')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Agent commands' }).parentElement?.textContent).toContain('2')
        expect(screen.getByRole('heading', { name: 'Skills' }).parentElement?.textContent).toContain('1')
        expect(screen.getByRole('heading', { name: 'MCP tools' }).parentElement?.textContent).toContain('1')
        expect(screen.getByRole('heading', { name: 'System tools' }).parentElement?.textContent).toContain('2')
        expect(screen.queryByText('Command')).not.toBeInTheDocument()
        expect(screen.queryByText('Tool')).not.toBeInTheDocument()
        expect(screen.getByRole('dialog').querySelector('.divide-y')).toBeNull()
        expect(Array.from(screen.getByRole('dialog').querySelectorAll('section h3')).map((heading) => heading.textContent)).toEqual([
            'Agent commands',
            'Skills',
            'MCP tools',
            'System tools'
        ])
        expect(screen.queryByText('Context window')).not.toBeInTheDocument()
        expect(screen.queryByText('Input')).not.toBeInTheDocument()
        expect(screen.queryByText('Context categories')).not.toBeInTheDocument()
        expect(screen.queryByText('Resources')).not.toBeInTheDocument()
    })

    it('recovers Claude lists from legacy top-level session metadata', () => {
        localStorage.setItem('hapi-lang', 'en')
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="claude"
                    contextDetails={{
                        version: 1,
                        updatedAt: 100,
                        provider: 'claude',
                        claude: {}
                    }}
                    legacyTools={['Read', 'Bash']}
                    legacySlashCommands={['/context', '/compact']}
                />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /Agent context details/ }))

        expect(screen.getByText('System tools')).toBeInTheDocument()
        expect(screen.getByText('Read')).toBeInTheDocument()
        expect(screen.getByText('Agent commands')).toBeInTheDocument()
        expect(screen.getByText('/compact')).toBeInTheDocument()
        expect(screen.queryByText('No detailed context information available.')).not.toBeInTheDocument()
    })

    it('does not resurrect legacy Claude lists after an authoritative empty refresh', () => {
        localStorage.setItem('hapi-lang', 'en')
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="claude"
                    contextDetails={{
                        version: 1,
                        updatedAt: 100,
                        provider: 'claude',
                        claude: {
                            systemTools: [],
                            slashCommands: []
                        }
                    }}
                    legacyTools={['Read']}
                    legacySlashCommands={['/compact']}
                />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /Agent context details/ }))

        expect(screen.queryByText('Read')).not.toBeInTheDocument()
        expect(screen.queryByText('/compact')).not.toBeInTheDocument()
        expect(screen.getByText('This agent has not reported additional context details yet.')).toBeInTheDocument()
    })

    it('renders detailed Codex skills and MCP tools from the agent status entry', async () => {
        localStorage.setItem('hapi-lang', 'en')
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="codex"
                    contextSize={11_000}
                    contextWindow={258_400}
                    contextDetails={{
                        version: 1,
                        updatedAt: 100,
                        provider: 'codex',
                        model: 'gpt-5.6-codex',
                        contextWindow: 258_400,
                        usage: { contextTokens: 11_000, cacheReadTokens: 8_000 },
                        codex: {
                            slashCommands: ['clear', 'compact'],
                            skills: [{ name: 'find-docs' }],
                            mcpServers: [{ name: 'hapi', toolNames: ['change_title', 'list_peers'] }]
                        }
                    }}
                />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /Agent context details/ }))

        expect(screen.getByText('Agent commands')).toBeInTheDocument()
        expect(screen.getByText('/clear')).toBeInTheDocument()
        expect(screen.getByText('/compact')).toBeInTheDocument()
        expect(screen.getByText('find-docs')).toBeInTheDocument()
        expect(screen.queryByText('Find docs')).not.toBeInTheDocument()
        expect(screen.getByText('MCP servers')).toBeInTheDocument()
        expect(screen.getByText('change_title')).toBeInTheDocument()
        expect(screen.getByText('list_peers')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Agent commands' }).parentElement?.textContent).toContain('2')
        expect(screen.getByRole('heading', { name: 'Skills' }).parentElement?.textContent).toContain('1')
        expect(screen.getByRole('heading', { name: 'MCP servers' }).parentElement?.textContent).toContain('1')
        expect(screen.queryByText('Command')).not.toBeInTheDocument()
        expect(screen.getByRole('dialog').querySelector('.divide-y')).toBeNull()
        expect(Array.from(screen.getByRole('dialog').querySelectorAll('section h3')).map((heading) => heading.textContent)).toEqual([
            'Agent commands',
            'Skills',
            'MCP servers'
        ])
        expect(screen.queryByText('System tools')).not.toBeInTheDocument()
        expect(screen.queryByText('Context window')).not.toBeInTheDocument()
        expect(screen.queryByText('Input')).not.toBeInTheDocument()
        expect(screen.queryByText('Runtime')).not.toBeInTheDocument()
    })

})
