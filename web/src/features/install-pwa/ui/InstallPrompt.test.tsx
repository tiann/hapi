import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { InstallPrompt } from './InstallPrompt'

vi.mock('../model/usePWAInstall', () => ({
    usePWAInstall: vi.fn()
}))

vi.mock('@/shared/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            impact: vi.fn(),
            notification: vi.fn()
        }
    })
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key
    })
}))

vi.mock('@/components/icons', () => ({
    CloseIcon: ({ className }: { className?: string }) => <span className={className}>X</span>,
    ShareIcon: ({ className }: { className?: string }) => <span className={className}>Share</span>,
    PlusCircleIcon: ({ className }: { className?: string }) => <span className={className}>+</span>
}))

import { usePWAInstall } from '../model/usePWAInstall'

describe('InstallPrompt', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        cleanup()
    })

    it('renders nothing when standalone', () => {
        vi.mocked(usePWAInstall).mockReturnValue({
            installState: 'installed',
            canInstall: false,
            canInstallIOS: false,
            isStandalone: true,
            isIOS: false,
            promptInstall: vi.fn(),
            dismissInstall: vi.fn()
        })

        const { container } = render(<InstallPrompt />)
        expect(container.firstChild).toBeNull()
    })

    it('renders nothing when cannot install', () => {
        vi.mocked(usePWAInstall).mockReturnValue({
            installState: 'idle',
            canInstall: false,
            canInstallIOS: false,
            isStandalone: false,
            isIOS: false,
            promptInstall: vi.fn(),
            dismissInstall: vi.fn()
        })

        const { container } = render(<InstallPrompt />)
        expect(container.firstChild).toBeNull()
    })

    it('renders Chrome/Edge install prompt when canInstall', () => {
        vi.mocked(usePWAInstall).mockReturnValue({
            installState: 'available',
            canInstall: true,
            canInstallIOS: false,
            isStandalone: false,
            isIOS: false,
            promptInstall: vi.fn(),
            dismissInstall: vi.fn()
        })

        render(<InstallPrompt />)

        expect(screen.getByText('install.title')).toBeInTheDocument()
        expect(screen.getByText('install.description')).toBeInTheDocument()
        expect(screen.getByText('install.button')).toBeInTheDocument()
    })

    it('calls promptInstall when install button clicked', async () => {
        const promptInstall = vi.fn().mockResolvedValue(true)

        vi.mocked(usePWAInstall).mockReturnValue({
            installState: 'available',
            canInstall: true,
            canInstallIOS: false,
            isStandalone: false,
            isIOS: false,
            promptInstall,
            dismissInstall: vi.fn()
        })

        render(<InstallPrompt />)

        const installButton = screen.getByText('install.button')
        fireEvent.click(installButton)

        expect(promptInstall).toHaveBeenCalled()
    })

    it('calls dismissInstall when dismiss button clicked', async () => {
        const dismissInstall = vi.fn()

        vi.mocked(usePWAInstall).mockReturnValue({
            installState: 'available',
            canInstall: true,
            canInstallIOS: false,
            isStandalone: false,
            isIOS: false,
            promptInstall: vi.fn(),
            dismissInstall
        })

        render(<InstallPrompt />)

        const dismissButton = screen.getByLabelText('Dismiss')
        fireEvent.click(dismissButton)

        expect(dismissInstall).toHaveBeenCalled()
    })

    it('renders iOS install banner when canInstallIOS', () => {
        vi.mocked(usePWAInstall).mockReturnValue({
            installState: 'idle',
            canInstall: false,
            canInstallIOS: true,
            isStandalone: false,
            isIOS: true,
            promptInstall: vi.fn(),
            dismissInstall: vi.fn()
        })

        render(<InstallPrompt />)

        expect(screen.getByText('install.title')).toBeInTheDocument()
        expect(screen.getByText('install.button')).toBeInTheDocument()
    })

    it('shows iOS guide when install button clicked on iOS', async () => {
        vi.mocked(usePWAInstall).mockReturnValue({
            installState: 'idle',
            canInstall: false,
            canInstallIOS: true,
            isStandalone: false,
            isIOS: true,
            promptInstall: vi.fn(),
            dismissInstall: vi.fn()
        })

        render(<InstallPrompt />)

        const installButton = screen.getByText('install.button')
        fireEvent.click(installButton)

        expect(screen.getByText(/Share button/)).toBeInTheDocument()
        expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument()
    })

    it('closes iOS guide when close button clicked', async () => {
        vi.mocked(usePWAInstall).mockReturnValue({
            installState: 'idle',
            canInstall: false,
            canInstallIOS: true,
            isStandalone: false,
            isIOS: true,
            promptInstall: vi.fn(),
            dismissInstall: vi.fn()
        })

        render(<InstallPrompt />)

        const installButton = screen.getByText('install.button')
        fireEvent.click(installButton)

        const closeButton = screen.getByLabelText('Close')
        fireEvent.click(closeButton)

        expect(screen.queryByText(/Share button/)).not.toBeInTheDocument()
    })

    it('dismisses install when dismiss button clicked in iOS guide', async () => {
        const dismissInstall = vi.fn()

        vi.mocked(usePWAInstall).mockReturnValue({
            installState: 'idle',
            canInstall: false,
            canInstallIOS: true,
            isStandalone: false,
            isIOS: true,
            promptInstall: vi.fn(),
            dismissInstall
        })

        render(<InstallPrompt />)

        const installButton = screen.getByText('install.button')
        fireEvent.click(installButton)

        const dismissButton = screen.getByText('button.dismiss')
        fireEvent.click(dismissButton)

        expect(dismissInstall).toHaveBeenCalled()
    })

    it('calls dismissInstall when dismiss button clicked on iOS banner', async () => {
        const dismissInstall = vi.fn()

        vi.mocked(usePWAInstall).mockReturnValue({
            installState: 'idle',
            canInstall: false,
            canInstallIOS: true,
            isStandalone: false,
            isIOS: true,
            promptInstall: vi.fn(),
            dismissInstall
        })

        render(<InstallPrompt />)

        const dismissButton = screen.getByLabelText('Dismiss')
        fireEvent.click(dismissButton)

        expect(dismissInstall).toHaveBeenCalled()
    })
})
