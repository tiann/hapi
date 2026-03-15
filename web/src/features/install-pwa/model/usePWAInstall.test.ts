import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePWAInstall } from './usePWAInstall'

describe('usePWAInstall', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        localStorage.clear()

        // Mock window.matchMedia
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn().mockImplementation(query => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })),
        })
    })

    it('returns initial state', () => {
        const { result } = renderHook(() => usePWAInstall())

        expect(result.current.installState).toBe('idle')
        expect(result.current.canInstall).toBe(false)
        expect(result.current.canInstallIOS).toBe(false)
        expect(result.current.isStandalone).toBe(false)
    })

    it('detects standalone mode', () => {
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn().mockImplementation(query => ({
                matches: query === '(display-mode: standalone)',
                media: query,
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })),
        })

        const { result } = renderHook(() => usePWAInstall())

        expect(result.current.isStandalone).toBe(true)
        expect(result.current.installState).toBe('installed')
    })

    it('sets install state to available when beforeinstallprompt fires', () => {
        const { result } = renderHook(() => usePWAInstall())

        act(() => {
            const event = new Event('beforeinstallprompt')
            Object.defineProperty(event, 'prompt', {
                value: vi.fn().mockResolvedValue(undefined)
            })
            Object.defineProperty(event, 'userChoice', {
                value: Promise.resolve({ outcome: 'accepted' })
            })
            window.dispatchEvent(event)
        })

        expect(result.current.installState).toBe('available')
        expect(result.current.canInstall).toBe(true)
    })

    it('promptInstall returns false when no deferred prompt', async () => {
        const { result } = renderHook(() => usePWAInstall())

        const success = await act(async () => {
            return await result.current.promptInstall()
        })

        expect(success).toBe(false)
    })

    it('promptInstall calls prompt and returns true on accept', async () => {
        const mockPrompt = vi.fn().mockResolvedValue(undefined)
        const mockUserChoice = Promise.resolve({ outcome: 'accepted' })

        const { result } = renderHook(() => usePWAInstall())

        act(() => {
            const event = new Event('beforeinstallprompt')
            Object.defineProperty(event, 'prompt', { value: mockPrompt })
            Object.defineProperty(event, 'userChoice', { value: mockUserChoice })
            window.dispatchEvent(event)
        })

        const success = await act(async () => {
            return await result.current.promptInstall()
        })

        expect(mockPrompt).toHaveBeenCalled()
        expect(success).toBe(true)
        expect(result.current.installState).toBe('installed')
    })

    it('promptInstall returns false on dismiss', async () => {
        const mockPrompt = vi.fn().mockResolvedValue(undefined)
        const mockUserChoice = Promise.resolve({ outcome: 'dismissed' })

        const { result } = renderHook(() => usePWAInstall())

        act(() => {
            const event = new Event('beforeinstallprompt')
            Object.defineProperty(event, 'prompt', { value: mockPrompt })
            Object.defineProperty(event, 'userChoice', { value: mockUserChoice })
            window.dispatchEvent(event)
        })

        const success = await act(async () => {
            return await result.current.promptInstall()
        })

        expect(success).toBe(false)
        expect(result.current.installState).toBe('idle')
    })

    it('dismissInstall sets dismissed state', () => {
        const { result } = renderHook(() => usePWAInstall())

        act(() => {
            const event = new Event('beforeinstallprompt')
            Object.defineProperty(event, 'prompt', {
                value: vi.fn().mockResolvedValue(undefined)
            })
            Object.defineProperty(event, 'userChoice', {
                value: Promise.resolve({ outcome: 'accepted' })
            })
            window.dispatchEvent(event)
        })

        expect(result.current.canInstall).toBe(true)

        act(() => {
            result.current.dismissInstall()
        })

        expect(result.current.canInstall).toBe(false)
        expect(localStorage.getItem('pwa_install_dismissed')).toBe('true')
    })

    it('respects dismissed state from localStorage', () => {
        localStorage.setItem('pwa_install_dismissed', 'true')

        const { result } = renderHook(() => usePWAInstall())

        act(() => {
            const event = new Event('beforeinstallprompt')
            Object.defineProperty(event, 'prompt', {
                value: vi.fn().mockResolvedValue(undefined)
            })
            Object.defineProperty(event, 'userChoice', {
                value: Promise.resolve({ outcome: 'accepted' })
            })
            window.dispatchEvent(event)
        })

        expect(result.current.installState).toBe('available')
        expect(result.current.canInstall).toBe(false)
    })

    it('sets install state to installed when appinstalled fires', () => {
        const { result } = renderHook(() => usePWAInstall())

        act(() => {
            const event = new Event('beforeinstallprompt')
            Object.defineProperty(event, 'prompt', {
                value: vi.fn().mockResolvedValue(undefined)
            })
            Object.defineProperty(event, 'userChoice', {
                value: Promise.resolve({ outcome: 'accepted' })
            })
            window.dispatchEvent(event)
        })

        expect(result.current.installState).toBe('available')

        act(() => {
            window.dispatchEvent(new Event('appinstalled'))
        })

        expect(result.current.installState).toBe('installed')
    })

    it('handles prompt error gracefully', async () => {
        const mockPrompt = vi.fn().mockRejectedValue(new Error('Failed'))

        const { result } = renderHook(() => usePWAInstall())

        act(() => {
            const event = new Event('beforeinstallprompt')
            Object.defineProperty(event, 'prompt', { value: mockPrompt })
            Object.defineProperty(event, 'userChoice', {
                value: Promise.resolve({ outcome: 'accepted' })
            })
            window.dispatchEvent(event)
        })

        const success = await act(async () => {
            return await result.current.promptInstall()
        })

        expect(success).toBe(false)
        expect(result.current.installState).toBe('idle')
    })
})
