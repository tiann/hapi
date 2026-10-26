import { AssistantRuntimeProvider, useLocalRuntime, useAuiState, type AssistantRuntime, type AttachmentAdapter, type ChatModelAdapter } from '@assistant-ui/react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SortableComposerAttachments } from './SortableComposerAttachments'
import { reconcileAttachmentOrder } from '@/lib/attachmentOrder'

const previewUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII='
const model: ChatModelAdapter = { async *run() {} }
const attachmentAdapter: AttachmentAdapter = {
    accept: 'image/*',
    async add({ file }) {
        return {
            id: file.name, name: file.name, type: 'image', contentType: file.type, file,
            status: { type: 'requires-action', reason: 'composer-send' }, previewUrl,
        }
    },
    async remove() {},
    async send(attachment) {
        return { ...attachment, status: { type: 'complete' }, content: [{ type: 'image', image: previewUrl }] }
    },
}

type HarnessProps = {
    disabled?: boolean
    order?: string[]
    onReorder?: (activeId: string, targetId: string, position: 'before' | 'after') => void
    runtimeRef: { current?: AssistantRuntime }
}
const noop = () => {}

function Attachments(props: HarnessProps) {
    const attachments = useAuiState((s) => s.composer.attachments)
    // HappyComposer also reconciles order on every render, returning a fresh array.
    const order = reconcileAttachmentOrder(props.order ?? [], attachments.map((a) => a.id))
    return <SortableComposerAttachments attachments={attachments} orderedAttachmentIds={order} disabled={props.disabled} onReorder={props.onReorder ?? noop} />
}

function Harness(props: HarnessProps) {
    const runtime = useLocalRuntime(model, { adapters: { attachments: attachmentAdapter } })
    props.runtimeRef.current = runtime
    return <AssistantRuntimeProvider runtime={runtime}><Attachments {...props} /></AssistantRuntimeProvider>
}

async function setup() {
    const runtimeRef: HarnessProps['runtimeRef'] = {}
    const view = render(<Harness runtimeRef={runtimeRef} />)
    await act(async () => {
        for (const name of ['first.png', 'second.png']) {
            await runtimeRef.current!.thread.composer.addAttachment(new File(['image'], name, { type: 'image/png' }))
        }
    })
    fireEvent.click(screen.getAllByTitle('Click to zoom')[0]!)
    return { ...view, runtimeRef }
}

describe('sortable composer image preview with the real attachment runtime', () => {
    it('keeps the active image and zoom across draft and parent updates', async () => {
        const { rerender, runtimeRef } = await setup()
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Next image' }))
        fireEvent.click(within(screen.getByRole('dialog')).getByTitle('Zoom in'))

        act(() => runtimeRef.current!.thread.composer.setText('draft update'))
        rerender(<Harness runtimeRef={runtimeRef} onReorder={vi.fn()} />)

        const dialog = screen.getByRole('dialog', { name: 'second.png' })
        expect(within(dialog).getByTitle('Reset zoom')).toHaveTextContent('125%')
        expect(within(dialog).getByRole('img')).toHaveAttribute('src', previewUrl)
    })

    it('keeps the preview while controls are disabled and re-enabled', async () => {
        const { rerender, runtimeRef } = await setup()
        rerender(<Harness runtimeRef={runtimeRef} disabled />)
        expect(screen.getByRole('dialog', { name: 'first.png' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Reorder attachment first.png' })).not.toBeInTheDocument()
        rerender(<Harness runtimeRef={runtimeRef} />)
        expect(screen.getByRole('dialog', { name: 'first.png' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Reorder attachment first.png' })).toBeInTheDocument()
    })

    it('preserves the viewer across reordering and uses the latest keyboard callback', async () => {
        const { rerender, runtimeRef, container } = await setup()
        const onReorder = vi.fn()
        rerender(<Harness runtimeRef={runtimeRef} order={['second.png', 'first.png']} onReorder={onReorder} />)
        expect(screen.getByRole('dialog', { name: 'first.png' })).toBeInTheDocument()
        fireEvent.keyDown(window, { key: 'Escape' })
        fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder attachment first.png' }), { key: 'ArrowLeft' })
        expect(onReorder).toHaveBeenCalledWith('first.png', 'second.png', 'before')
        expect(Array.from(container.querySelectorAll<HTMLElement>('[data-hapi-composer-attachment-id]')).map((el) => el.dataset.hapiComposerAttachmentId)).toEqual(['second.png', 'first.png'])
    })

    it('still closes explicitly and removes an attachment through the real runtime', async () => {
        const { runtimeRef, container } = await setup()
        fireEvent.click(within(screen.getByRole('dialog')).getByTitle('Close'))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        fireEvent.click(screen.getAllByTitle('Click to zoom')[0]!)
        await act(async () => runtimeRef.current!.thread.composer.clearAttachments())
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(container.querySelector('[data-hapi-composer-attachment-id]')).toBeNull()
    })
})
