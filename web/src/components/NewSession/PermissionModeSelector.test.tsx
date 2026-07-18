import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { PermissionModeSelector } from './PermissionModeSelector'

function renderWithProviders(ui: React.ReactElement) {
    return render(
        <I18nProvider>
            {ui}
        </I18nProvider>
    )
}

describe('PermissionModeSelector', () => {
    afterEach(() => cleanup())

    it('exposes all Antigravity agy permission modes', () => {
        const onChange = vi.fn()
        renderWithProviders(
            <PermissionModeSelector
                agent="agy"
                mode="default"
                isDisabled={false}
                onChange={onChange}
            />
        )

        const select = screen.getByLabelText('Permission mode')
        expect(screen.getByRole('option', { name: 'Default' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'Read Only' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'Safe Yolo' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'Yolo' })).toBeInTheDocument()

        fireEvent.change(select, { target: { value: 'safe-yolo' } })
        expect(onChange).toHaveBeenCalledWith('safe-yolo')
    })

    it('exposes all Grok permission modes', () => {
        renderWithProviders(
            <PermissionModeSelector agent="grok" mode="default" isDisabled={false} onChange={vi.fn()} />
        )
        expect(screen.getByRole('option', { name: 'Default' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'Read Only' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'Safe Yolo' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'Yolo' })).toBeInTheDocument()
    })

    it('intersects permission modes with the selected machine report', () => {
        renderWithProviders(
            <PermissionModeSelector
                agent="grok"
                mode="default"
                allowedModes={['default', 'safe-yolo']}
                isDisabled={false}
                onChange={vi.fn()}
            />
        )

        expect(screen.getByRole('option', { name: 'Default' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'Safe Yolo' })).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Read Only' })).not.toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Yolo' })).not.toBeInTheDocument()
    })

    it('is hidden for non-agy agents', () => {
        renderWithProviders(
            <PermissionModeSelector
                agent="claude"
                mode="default"
                isDisabled={false}
                onChange={vi.fn()}
            />
        )

        expect(screen.queryByLabelText('Permission mode')).not.toBeInTheDocument()
    })

    it('exposes only Hermes MoA default/yolo permission modes', () => {
        const onChange = vi.fn()
        renderWithProviders(
            <PermissionModeSelector
                agent="hermes-moa"
                mode="default"
                isDisabled={false}
                onChange={onChange}
            />
        )

        const select = screen.getByLabelText('Permission mode')
        expect(screen.getByRole('option', { name: 'Default' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'Yolo' })).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Read Only' })).not.toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Safe Yolo' })).not.toBeInTheDocument()

        fireEvent.change(select, { target: { value: 'yolo' } })
        expect(onChange).toHaveBeenCalledWith('yolo')
    })
})
