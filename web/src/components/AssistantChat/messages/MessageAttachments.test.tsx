import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageAttachments } from './MessageAttachments'
import type { AttachmentMetadata } from '@/types/api'

vi.mock('@/components/ImagePreview', () => ({ ImagePreview: ({ fileName }: { fileName: string }) => <span>{fileName}</span> }))
afterEach(cleanup)
const image = (id: string): AttachmentMetadata => ({ id, filename: `${id}.png`, mimeType: 'image/png', size: 1, path: `/tmp/${id}`, previewUrl: 'data:image/png;base64,a' })
const file = (id: string): AttachmentMetadata => ({ id, filename: `${id}.txt`, mimeType: 'text/plain', size: 1, path: `/tmp/${id}` })

describe('sent attachment display order', () => {
    it('preserves alternating file/image order instead of regrouping by type', () => {
        render(<MessageAttachments attachments={[file('a'), image('b'), file('c'), image('d')]} />)
        const names = screen.getAllByText(/^[abcd]\.(txt|png)$/)
        expect(names.map((node) => node.textContent)).toEqual(['a.txt', 'b.png', 'c.txt', 'd.png'])
    })

    it('keeps adjacent images in the existing shared media grid', () => {
        const { container } = render(<MessageAttachments attachments={[image('a'), image('b'), file('c')]} />)
        expect(container.querySelector('[data-hapi-image-count="2"]')).toHaveTextContent('a.pngb.png')
    })
})
