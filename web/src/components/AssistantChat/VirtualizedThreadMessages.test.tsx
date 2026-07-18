import { createRef, type ReactNode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const assistantState = vi.hoisted(() => ({
    messages: Array.from({ length: 10_000 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
    })),
    activeMessage: null as null | {
        id: string
        role: string
        index: number
        composer: { isEditing: boolean }
    },
}))

vi.mock('@assistant-ui/react', () => ({
    useAssistantState: (selector: (state: {
        thread: { messages: typeof assistantState.messages }
        message: NonNullable<typeof assistantState.activeMessage>
    }) => unknown) => selector({
        thread: { messages: assistantState.messages },
        message: assistantState.activeMessage!,
    }),
    ThreadPrimitive: {
        Messages: ({ components }: { components: { Message: () => ReactNode } }) => (
            <div data-testid="native-message-list">
                {assistantState.messages.map((message, index) => {
                    assistantState.activeMessage = {
                        ...message,
                        index,
                        composer: { isEditing: false },
                    }
                    return <span key={message.id}>{components.Message()}</span>
                })}
            </div>
        ),
        MessageByIndex: ({ index }: { index: number; components: unknown }) => (
            <div data-testid="indexed-message">message-{index}</div>
        ),
    },
}))

import {
    VirtualizedThreadMessages,
    type VirtualizedThreadMessagesHandle,
} from './VirtualizedThreadMessages'

describe('VirtualizedThreadMessages', () => {
    beforeEach(() => {
        assistantState.messages = Array.from({ length: 10_000 }, (_, index) => ({
            id: `message-${index}`,
            role: index % 2 === 0 ? 'user' : 'assistant',
        }))
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
            return this.dataset.testid === 'virtual-thread-row' ? 72 : 600
        })
        vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const height = this.dataset.testid === 'virtual-thread-row' ? 72 : 600
            return new DOMRect(0, 0, 800, height)
        })
    })

    afterEach(() => {
        cleanup()
        vi.restoreAllMocks()
    })

    it('keeps a 10,000-message thread bounded and exposes stable message ids', async () => {
        const viewportRef = createRef<HTMLDivElement>()
        const Message = ({ children }: { children?: ReactNode }) => <>{children}</>

        render(
            <div ref={viewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    viewportRef={viewportRef}
                    components={{ Message }}
                />
            </div>,
        )

        await waitFor(() => expect(screen.getAllByTestId('virtual-thread-row').length).toBeGreaterThan(0))
        const rows = screen.getAllByTestId('virtual-thread-row')
        expect(rows.length).toBeLessThan(100)
        expect(rows[0]).toHaveAttribute('data-hapi-message-id', 'message-0')
        expect(screen.getAllByTestId('indexed-message')).toHaveLength(rows.length)
        expect(screen.queryByTestId('native-message-list')).not.toBeInTheDocument()
    })

    it('keeps every row mounted for ordinary history windows', async () => {
        assistantState.messages = Array.from({ length: 80 }, (_, index) => ({
            id: `message-${index}`,
            role: index % 2 === 0 ? 'user' : 'assistant',
        }))
        const viewportRef = createRef<HTMLDivElement>()
        const Message = ({ children }: { children?: ReactNode }) => <>{children}</>

        render(
            <div ref={viewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    viewportRef={viewportRef}
                    components={{ Message }}
                />
            </div>,
        )

        await waitFor(() => expect(screen.getAllByTestId('virtual-thread-row')).toHaveLength(80))
        expect(screen.getAllByTestId('virtual-thread-row')[79]).toHaveAttribute('data-hapi-message-id', 'message-79')
        expect(screen.getByTestId('native-message-list')).toBeInTheDocument()
        expect(screen.queryByTestId('indexed-message')).not.toBeInTheDocument()
    })

    it('delegates ordinary windows to the native coherent message list during replacements', async () => {
        assistantState.messages = Array.from({ length: 80 }, (_, index) => ({
            id: `stable-${index}`,
            role: index % 2 === 0 ? 'user' : 'assistant',
        }))
        const viewportRef = createRef<HTMLDivElement>()
        const Message = () => <div>stable row body</div>

        render(
            <div ref={viewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    viewportRef={viewportRef}
                    components={{ Message }}
                />
            </div>,
        )

        await waitFor(() => expect(screen.getAllByTestId('virtual-thread-row')).toHaveLength(80))
        expect(screen.getByTestId('native-message-list')).toBeInTheDocument()
        expect(screen.getAllByTestId('virtual-thread-row')[0]).toHaveAttribute('data-hapi-message-id', 'stable-0')
        expect(screen.queryByTestId('indexed-message')).not.toBeInTheDocument()
    })

    it('switches from the 200-row native list to a bounded virtual list at 201 rows', async () => {
        assistantState.messages = Array.from({ length: 200 }, (_, index) => ({
            id: `message-${index}`,
            role: index % 2 === 0 ? 'user' : 'assistant',
        }))
        const viewportRef = createRef<HTMLDivElement>()
        const Message = ({ children }: { children?: ReactNode }) => <>{children}</>
        const rendered = render(
            <div ref={viewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    viewportRef={viewportRef}
                    components={{ Message }}
                />
            </div>,
        )

        await waitFor(() => expect(screen.getAllByTestId('virtual-thread-row')).toHaveLength(200))
        expect(screen.getByTestId('native-message-list')).toBeInTheDocument()
        expect(screen.getAllByTestId('virtual-thread-row')[199]).toHaveAttribute(
            'data-hapi-message-id',
            'message-199',
        )

        assistantState.messages = [
            ...assistantState.messages,
            { id: 'message-200', role: 'user' },
        ]
        rendered.rerender(
            <div ref={viewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    viewportRef={viewportRef}
                    components={{ Message }}
                />
            </div>,
        )

        await waitFor(() => expect(screen.queryByTestId('native-message-list')).not.toBeInTheDocument())
        const virtualRows = screen.getAllByTestId('virtual-thread-row')
        expect(virtualRows.length).toBeGreaterThan(0)
        expect(virtualRows.length).toBeLessThan(100)
        expect(virtualRows[0]).toHaveAttribute('data-hapi-message-id', 'message-0')
        expect(screen.getAllByTestId('indexed-message')).toHaveLength(virtualRows.length)
    })

    it('restores from the physical viewport offset when the virtualizer offset is stale', async () => {
        const viewportRef = createRef<HTMLDivElement>()
        const messagesRef = createRef<VirtualizedThreadMessagesHandle>()
        const Message = ({ children }: { children?: ReactNode }) => <>{children}</>

        const rendered = render(
            <div ref={viewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    ref={messagesRef}
                    viewportRef={viewportRef}
                    components={{ Message }}
                />
            </div>,
        )
        rendered.rerender(
            <div ref={viewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    ref={messagesRef}
                    viewportRef={viewportRef}
                    components={{ Message }}
                />
            </div>,
        )

        await screen.findAllByTestId('virtual-thread-row')
        const row = rendered.container.querySelector<HTMLElement>('[data-hapi-message-id="message-0"]')!
        const viewport = viewportRef.current!
        const scrollTo = vi.fn()
        Object.defineProperty(viewport, 'scrollHeight', {
            configurable: true,
            value: 10_000,
        })
        Object.defineProperty(viewport, 'scrollTo', {
            configurable: true,
            value: scrollTo,
        })
        viewport.scrollTop = 100
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.dataset.hapiMessageId === 'message-0') {
                return new DOMRect(0, 50, 800, 72)
            }
            return new DOMRect(0, 0, 800, this.dataset.testid === 'virtual-thread-row' ? 72 : 600)
        })
        expect(row.getBoundingClientRect().top).toBe(50)

        let result: ReturnType<VirtualizedThreadMessagesHandle['restoreMessageAnchor']> | undefined
        act(() => {
            result = messagesRef.current!.restoreMessageAnchor('message-0', 0)
        })

        expect(result).toEqual({ found: true, mounted: true, deviation: 50 })
        expect(scrollTo).toHaveBeenCalledWith({ top: 150, behavior: 'auto' })
    })

    it('does not rewind when the composed viewport ref is transiently null between commits', async () => {
        const mountedViewportRef = createRef<HTMLDivElement>()
        const viewportRef = { current: null as HTMLDivElement | null }
        const Message = ({ children }: { children?: ReactNode }) => <>{children}</>
        const rendered = render(
            <div ref={mountedViewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    viewportRef={viewportRef}
                    components={{ Message }}
                />
            </div>,
        )

        viewportRef.current = mountedViewportRef.current
        rendered.rerender(
            <div ref={mountedViewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    viewportRef={viewportRef}
                    components={{ Message }}
                />
            </div>,
        )
        await screen.findAllByTestId('virtual-thread-row')

        const viewport = mountedViewportRef.current!
        const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
            if (typeof top === 'number') {
                viewport.scrollTop = top
            }
        })
        Object.defineProperty(viewport, 'scrollTo', {
            configurable: true,
            value: scrollTo,
        })
        viewport.scrollTop = 500

        viewportRef.current = null
        rendered.rerender(
            <div ref={mountedViewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    viewportRef={viewportRef}
                    components={{ Message }}
                />
            </div>,
        )
        viewportRef.current = viewport
        rendered.rerender(
            <div ref={mountedViewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    viewportRef={viewportRef}
                    components={{ Message }}
                />
            </div>,
        )

        expect(scrollTo).not.toHaveBeenCalled()
        expect(viewport.scrollTop).toBe(500)
    })
})
