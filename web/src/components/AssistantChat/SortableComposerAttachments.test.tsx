import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type React from 'react'
import { moveAttachmentId } from '@/lib/attachmentOrder'

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')
    return {
        ComposerPrimitive: {
            AttachmentByIndex: (props: {
                index: number
                components?: { Attachment?: React.ComponentType }
            }) => {
                const Component = props.components?.Attachment
                return (
                    <div data-testid={`attachment-index-${props.index}`}>
                        {Component ? <Component /> : null}
                    </div>
                )
            },
        },
    }
})

vi.mock('./AttachmentItem', () => ({
    AttachmentItem: (props: {
        dragHandleProps?: {
            onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void
            onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
            ariaLabel: string
            title: string
            onSurfacePointerDown?: (event: React.PointerEvent<HTMLElement>) => void
            onSurfaceContextMenu?: (event: React.MouseEvent<HTMLElement>) => void
            onSurfaceClick?: (event: React.MouseEvent<HTMLElement>) => void
        }
    }) => props.dragHandleProps ? (
        <>
            <button
                type="button"
                data-testid="attachment-drag-handle"
                aria-label={props.dragHandleProps.ariaLabel}
                title={props.dragHandleProps.title}
                onPointerDown={props.dragHandleProps.onPointerDown}
                onKeyDown={props.dragHandleProps.onKeyDown}
            />
            <div
                data-testid="attachment-surface"
                onPointerDown={props.dragHandleProps.onSurfacePointerDown}
                onContextMenu={props.dragHandleProps.onSurfaceContextMenu}
                onClick={props.dragHandleProps.onSurfaceClick}
            />
        </>
    ) : null,
}))

import { SortableComposerAttachments } from './SortableComposerAttachments'

const attachments = [
    { id: 'a', name: 'a.png', type: 'file', contentType: 'image/png' },
    { id: 'b', name: 'b.txt', type: 'file', contentType: 'text/plain' },
    { id: 'c', name: 'c.png', type: 'file', contentType: 'image/png' },
] as never[]

function Harness() {
    const [order, setOrder] = useState(['a', 'b', 'c'])
    return (
        <SortableComposerAttachments
            attachments={attachments}
            orderedAttachmentIds={order}
            onReorder={(activeId, targetId, position) => {
                setOrder((current) => moveAttachmentId(current, activeId, targetId, position))
            }}
        />
    )
}

function dispatchPointerEvent(
    target: EventTarget,
    type: string,
    init: { button?: number; pointerId: number; clientX: number; clientY: number },
): void {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
        button: { value: init.button ?? 0 },
        pointerId: { value: init.pointerId },
        clientX: { value: init.clientX },
        clientY: { value: init.clientY },
    })
    target.dispatchEvent(event)
}

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

describe('SortableComposerAttachments', () => {
    it('reorders an image or file when its drag handle crosses another attachment', () => {
        const elementsFromPoint = vi.fn(() => [
            document.querySelector('[data-hapi-composer-attachment-id="c"]')!,
        ])
        Object.defineProperty(document, 'elementsFromPoint', {
            configurable: true,
            value: elementsFromPoint,
        })

        const { container } = render(<Harness />)
        vi.spyOn(
            container.querySelector('[data-hapi-composer-attachment-id="c"]')!,
            'getBoundingClientRect',
        ).mockReturnValue({ left: 100, width: 100, right: 200, top: 0, bottom: 50, height: 50 } as DOMRect)
        const handle = screen.getByRole('button', { name: 'Reorder attachment a.png' })

        act(() => {
            dispatchPointerEvent(handle, 'pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
            dispatchPointerEvent(handle, 'pointermove', { pointerId: 1, clientX: 20, clientY: 0 })
            dispatchPointerEvent(handle, 'pointerup', { pointerId: 1, clientX: 20, clientY: 0 })
        })

        expect(elementsFromPoint).toHaveBeenCalled()
        expect(Array.from(
            container.querySelectorAll<HTMLElement>('[data-hapi-composer-attachment-id]'),
        ).map((element) => element.dataset.hapiComposerAttachmentId)).toEqual(['b', 'a', 'c'])
    })

    it('moves the first attachment after the second when dragged across its midpoint', () => {
        const elementsFromPoint = vi.fn(() => [
            document.querySelector('[data-hapi-composer-attachment-id="b"]')!,
        ])
        Object.defineProperty(document, 'elementsFromPoint', {
            configurable: true,
            value: elementsFromPoint,
        })

        const { container } = render(<Harness />)
        vi.spyOn(
            container.querySelector('[data-hapi-composer-attachment-id="b"]')!,
            'getBoundingClientRect',
        ).mockReturnValue({ left: 0, width: 100, right: 100, top: 0, bottom: 50, height: 50 } as DOMRect)
        const handle = screen.getByRole('button', { name: 'Reorder attachment a.png' })

        act(() => {
            dispatchPointerEvent(handle, 'pointerdown', { button: 0, pointerId: 3, clientX: 0, clientY: 0 })
            dispatchPointerEvent(handle, 'pointermove', { pointerId: 3, clientX: 80, clientY: 0 })
            dispatchPointerEvent(handle, 'pointerup', { pointerId: 3, clientX: 80, clientY: 0 })
        })

        expect(Array.from(
            container.querySelectorAll<HTMLElement>('[data-hapi-composer-attachment-id]'),
        ).map((element) => element.dataset.hapiComposerAttachmentId)).toEqual(['b', 'a', 'c'])
    })

    it('supports keyboard movement through the same ordering path', () => {
        const { container } = render(<Harness />)
        fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder attachment b.txt' }), { key: 'ArrowLeft' })

        expect(Array.from(
            container.querySelectorAll<HTMLElement>('[data-hapi-composer-attachment-id]'),
        ).map((element) => element.dataset.hapiComposerAttachmentId)).toEqual(['b', 'a', 'c'])
    })

    it('moves an attachment right with the keyboard', () => {
        const { container } = render(<Harness />)
        fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder attachment b.txt' }), { key: 'ArrowRight' })

        expect(Array.from(
            container.querySelectorAll<HTMLElement>('[data-hapi-composer-attachment-id]'),
        ).map((element) => element.dataset.hapiComposerAttachmentId)).toEqual(['a', 'c', 'b'])
    })

    it('starts a drag from an image surface and suppresses its long-press menu', () => {
        const elementsFromPoint = vi.fn(() => [
            document.querySelector('[data-hapi-composer-attachment-id="c"]')!,
        ])
        Object.defineProperty(document, 'elementsFromPoint', {
            configurable: true,
            value: elementsFromPoint,
        })

        const { container } = render(<Harness />)
        vi.spyOn(
            container.querySelector('[data-hapi-composer-attachment-id="c"]')!,
            'getBoundingClientRect',
        ).mockReturnValue({ left: 100, width: 100, right: 200, top: 0, bottom: 50, height: 50 } as DOMRect)
        const surface = screen.getAllByTestId('attachment-surface')[0]!
        const contextMenu = new Event('contextmenu', { bubbles: true, cancelable: true })

        act(() => {
            dispatchPointerEvent(surface, 'pointerdown', { button: 0, pointerId: 2, clientX: 0, clientY: 0 })
        })
        surface.dispatchEvent(contextMenu)
        expect(contextMenu.defaultPrevented).toBe(true)

        act(() => {
            dispatchPointerEvent(surface, 'pointermove', { pointerId: 2, clientX: 20, clientY: 0 })
            dispatchPointerEvent(surface, 'pointerup', { pointerId: 2, clientX: 20, clientY: 0 })
        })

        expect(Array.from(
            container.querySelectorAll<HTMLElement>('[data-hapi-composer-attachment-id]'),
        ).map((element) => element.dataset.hapiComposerAttachmentId)).toEqual(['b', 'a', 'c'])
    })
})
