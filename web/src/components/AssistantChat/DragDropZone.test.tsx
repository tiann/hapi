import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

const addAttachment = vi.fn()

vi.mock('@assistant-ui/react', () => ({
    useAssistantApi: () => ({
        composer: () => ({ addAttachment }),
    }),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { DragDropZone } from './DragDropZone'

function createDropEvent(types: string[], files: File[]): Event {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
        value: { types, files },
        configurable: true,
    })
    return event
}

describe('DragDropZone drop handling', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('adds dropped files as attachments and cancels the browser default', () => {
        const { container } = render(
            <DragDropZone>
                <div />
            </DragDropZone>
        )
        const zone = container.firstChild as HTMLElement
        const file = new File(['x'], 'a.txt', { type: 'text/plain' })
        const event = createDropEvent(['Files'], [file])

        fireEvent(zone, event)

        expect(event.defaultPrevented).toBe(true)
        expect(addAttachment).toHaveBeenCalledTimes(1)
        expect(addAttachment).toHaveBeenCalledWith(file)
    })

    it('ignores non-file drops so the browser keeps its default (e.g. text into composer)', () => {
        const { container } = render(
            <DragDropZone>
                <div />
            </DragDropZone>
        )
        const zone = container.firstChild as HTMLElement
        const event = createDropEvent(['text/plain'], [])

        fireEvent(zone, event)

        expect(event.defaultPrevented).toBe(false)
        expect(addAttachment).not.toHaveBeenCalled()
    })

    it('does not attach when disabled but still cancels the file default', () => {
        const { container } = render(
            <DragDropZone disabled>
                <div />
            </DragDropZone>
        )
        const zone = container.firstChild as HTMLElement
        const file = new File(['x'], 'a.txt', { type: 'text/plain' })
        const event = createDropEvent(['Files'], [file])

        fireEvent(zone, event)

        expect(event.defaultPrevented).toBe(true)
        expect(addAttachment).not.toHaveBeenCalled()
    })
})
