import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePlatform, getPlatform } from './usePlatform'

describe('usePlatform', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('detects touch device', () => {
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn().mockImplementation((query) => ({
                matches: query === '(pointer: coarse)',
                media: query,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            })),
        })

        const { result } = renderHook(() => usePlatform())
        expect(result.current.isTouch).toBe(true)
    })

    it('detects non-touch device', () => {
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn().mockImplementation((query) => ({
                matches: false,
                media: query,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            })),
        })

        const { result } = renderHook(() => usePlatform())
        expect(result.current.isTouch).toBe(false)
    })

    it('provides haptic feedback interface', () => {
        const { result } = renderHook(() => usePlatform())
        expect(result.current.haptic).toHaveProperty('impact')
        expect(result.current.haptic).toHaveProperty('notification')
        expect(result.current.haptic).toHaveProperty('selection')
    })

    it('haptic impact calls vibrate', () => {
        const vibrateMock = vi.fn()
        Object.defineProperty(navigator, 'vibrate', {
            writable: true,
            value: vibrateMock,
        })

        const { result } = renderHook(() => usePlatform())
        result.current.haptic.impact('medium')

        expect(vibrateMock).toHaveBeenCalledWith(20)
    })

    it('haptic notification calls vibrate with pattern', () => {
        const vibrateMock = vi.fn()
        Object.defineProperty(navigator, 'vibrate', {
            writable: true,
            value: vibrateMock,
        })

        const { result } = renderHook(() => usePlatform())
        result.current.haptic.notification('error')

        expect(vibrateMock).toHaveBeenCalledWith([30, 50, 30])
    })

    it('haptic selection calls vibrate', () => {
        const vibrateMock = vi.fn()
        Object.defineProperty(navigator, 'vibrate', {
            writable: true,
            value: vibrateMock,
        })

        const { result } = renderHook(() => usePlatform())
        result.current.haptic.selection()

        expect(vibrateMock).toHaveBeenCalledWith(5)
    })

    it('handles missing vibrate API gracefully', () => {
        Object.defineProperty(navigator, 'vibrate', {
            writable: true,
            value: undefined,
        })

        const { result } = renderHook(() => usePlatform())
        expect(() => result.current.haptic.impact('light')).not.toThrow()
    })
})

describe('getPlatform', () => {
    it('returns platform info without React', () => {
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn().mockImplementation(() => ({
                matches: true,
            })),
        })

        const platform = getPlatform()
        expect(platform.isTouch).toBe(true)
        expect(platform.haptic).toHaveProperty('impact')
    })
})
