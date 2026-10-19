import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { AttachmentPicker } from './AttachmentPicker'

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

function renderPicker(props: Partial<ComponentProps<typeof AttachmentPicker>> = {}) {
    const onFilesSelected = props.onFilesSelected ?? vi.fn()
    render(
        <I18nProvider>
            <AttachmentPicker onFilesSelected={onFilesSelected} {...props} />
        </I18nProvider>,
    )
    return { onFilesSelected }
}

describe('AttachmentPicker', () => {
    it('opens one HAPI-styled panel with photo, camera, and file actions', () => {
        renderPicker()

        fireEvent.click(screen.getByTestId('composer-attachment-picker-trigger'))

        expect(screen.getByRole('dialog', { name: 'Add attachment' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Photos' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Camera' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument()
    })

    it('configures separate native pickers for photos, camera, and files', () => {
        renderPicker()

        const photos = screen.getByTestId('composer-attachment-input-photos')
        const camera = screen.getByTestId('composer-attachment-input-camera')
        const files = screen.getByTestId('composer-attachment-input-files')

        expect(photos).toHaveAttribute('type', 'file')
        expect(photos).toHaveAttribute('accept', 'image/*')
        expect(photos).toHaveAttribute('multiple')
        expect(camera).toHaveAttribute('accept', 'image/*')
        expect(camera).toHaveAttribute('capture', 'environment')
        expect(camera).not.toHaveAttribute('multiple')
        expect(files).toHaveAttribute('accept', '*/*')
        expect(files).toHaveAttribute('multiple')
    })

    it('opens the selected native picker and closes the panel', () => {
        const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
        renderPicker()

        fireEvent.click(screen.getByTestId('composer-attachment-picker-trigger'))
        fireEvent.click(screen.getByRole('button', { name: 'Photos' }))

        expect(click).toHaveBeenCalledOnce()
        expect(click.mock.instances[0]).toBe(screen.getByTestId('composer-attachment-input-photos'))
        expect(screen.queryByRole('dialog', { name: 'Add attachment' })).not.toBeInTheDocument()
    })

    it('forwards all selected files and allows selecting the same file again', () => {
        const onFilesSelected = vi.fn()
        renderPicker({ onFilesSelected })
        const input = screen.getByTestId('composer-attachment-input-photos') as HTMLInputElement
        const first = new File(['one'], 'one.png', { type: 'image/png' })
        const second = new File(['two'], 'two.jpg', { type: 'image/jpeg' })

        fireEvent.change(input, { target: { files: [first, second] } })

        expect(onFilesSelected).toHaveBeenCalledOnce()
        expect(onFilesSelected).toHaveBeenCalledWith([first, second])
        expect(input.value).toBe('')
    })

    it('does not open when disabled', () => {
        renderPicker({ disabled: true })

        fireEvent.click(screen.getByTestId('composer-attachment-picker-trigger'))

        expect(screen.queryByRole('dialog', { name: 'Add attachment' })).not.toBeInTheDocument()
    })
})
