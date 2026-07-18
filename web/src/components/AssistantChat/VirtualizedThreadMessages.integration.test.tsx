import { createRef, useMemo } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
    AssistantRuntimeProvider,
    useExternalMessageConverter,
    useExternalStoreRuntime,
    type ThreadMessageLike,
} from '@assistant-ui/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VirtualizedThreadMessages } from './VirtualizedThreadMessages'

function createMessages(count: number): ThreadMessageLike[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `message-${index}`,
        role: index === 0 ? 'system' : index % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `message ${index}` }],
        createdAt: new Date(index),
    }))
}

function RuntimeHarness(props: { messages: ThreadMessageLike[] }) {
    const convertedMessages = useExternalMessageConverter<ThreadMessageLike>({
        callback: (message) => message,
        messages: props.messages,
        isRunning: false,
    })
    const adapter = useMemo(() => ({
        messages: convertedMessages,
        isRunning: false,
        onNew: async () => {},
    }), [convertedMessages])
    const runtime = useExternalStoreRuntime(adapter)
    const viewportRef = createRef<HTMLDivElement>()
    const UserMessage = () => <div data-testid="real-user-message" />
    const AssistantMessage = () => <div data-testid="real-assistant-message" />
    const SystemMessage = () => <div data-testid="real-system-message" />

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div ref={viewportRef} style={{ height: 600, overflow: 'auto' }}>
                <VirtualizedThreadMessages
                    viewportRef={viewportRef}
                    components={{ UserMessage, AssistantMessage, SystemMessage }}
                />
            </div>
        </AssistantRuntimeProvider>
    )
}

describe('VirtualizedThreadMessages assistant-ui role dispatch', () => {
    beforeEach(() => {
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

    it.each([
        ['native', 200],
        ['virtual', 201],
    ] as const)('renders system/event rows through real %s role dispatch at %i messages', async (_mode, count) => {
        render(<RuntimeHarness messages={createMessages(count)} />)

        await waitFor(() => expect(screen.getByTestId('real-system-message')).toBeInTheDocument())
        expect(screen.getAllByTestId('real-system-message')).toHaveLength(1)
    })
})
