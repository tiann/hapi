import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

describe('StatusBar context details popover', () => {
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
        expect(screen.queryByText('上下文详情')).toBeNull()
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
})
