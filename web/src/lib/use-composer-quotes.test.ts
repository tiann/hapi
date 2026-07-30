import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistQuotes, readQuotes, type Quote } from './quotes'
import { useComposerQuotes } from './use-composer-quotes'

const A = 'session-a'
const B = 'session-b'
const row = (id: string, text: string): Quote => ({ id, text, messageId: 'm1', createdAt: 1 })

describe('useComposerQuotes', () => {
    beforeEach(() => localStorage.clear())
    afterEach(() => localStorage.clear())

    it('hydrates from storage on mount', () => {
        persistQuotes(A, [row('1', 'alpha')])
        const { result } = renderHook(({ id }: { id: string }) => useComposerQuotes(id), {
            initialProps: { id: A },
        })
        expect(result.current.quotes.map((q) => q.text)).toEqual(['alpha'])
    })

    it('add() appends and persists', () => {
        const { result } = renderHook(({ id }: { id: string }) => useComposerQuotes(id), {
            initialProps: { id: A },
        })
        act(() => { result.current.add('alpha', 'msg-1') })
        expect(result.current.quotes.map((q) => q.text)).toEqual(['alpha'])
        expect(readQuotes(A).map((q) => q.text)).toEqual(['alpha'])
    })

    it('remove() drops only the target', () => {
        const { result } = renderHook(({ id }: { id: string }) => useComposerQuotes(id), {
            initialProps: { id: A },
        })
        act(() => { result.current.add('alpha', 'm1') })
        act(() => { result.current.add('beta', 'm2') })
        const firstId = result.current.quotes[0]!.id
        act(() => { result.current.remove(firstId) })
        expect(result.current.quotes.map((q) => q.text)).toEqual(['beta'])
    })

    it('clear() empties the list and storage', () => {
        const { result } = renderHook(({ id }: { id: string }) => useComposerQuotes(id), {
            initialProps: { id: A },
        })
        act(() => { result.current.add('alpha', 'm1') })
        act(() => { result.current.clear() })
        expect(result.current.quotes).toEqual([])
        expect(readQuotes(A)).toEqual([])
    })

    it('switching sessions never writes the old sessions quotes into the new key', () => {
        persistQuotes(A, [row('1', 'a-original')])
        persistQuotes(B, [row('2', 'b-original')])
        const { rerender } = renderHook(({ id }: { id: string }) => useComposerQuotes(id), {
            initialProps: { id: A },
        })
        const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
        rerender({ id: B })
        const corrupting = setItemSpy.mock.calls.filter(([key, value]) => {
            if (typeof key !== 'string' || typeof value !== 'string') return false
            if (!key.endsWith(B)) return false
            try {
                const parsed = JSON.parse(value)
                return Array.isArray(parsed) && parsed.some((r: { text?: string }) => r?.text === 'a-original')
            } catch { return false }
        })
        setItemSpy.mockRestore()
        expect(corrupting).toEqual([])
    })

    it('after switching sessions, add() targets the new session', () => {
        persistQuotes(A, [row('1', 'a-original')])
        const { result, rerender } = renderHook(({ id }: { id: string }) => useComposerQuotes(id), {
            initialProps: { id: A },
        })
        rerender({ id: B })
        act(() => { result.current.add('b-only', 'm9') })
        expect(readQuotes(B).map((q) => q.text)).toEqual(['b-only'])
        expect(readQuotes(A).map((q) => q.text)).toEqual(['a-original'])
    })

    it('refuses to add past QUOTES_MAX', async () => {
        const { QUOTES_MAX } = await import('./quotes')
        const { result } = renderHook(({ id }: { id: string }) => useComposerQuotes(id), {
            initialProps: { id: A },
        })
        act(() => {
            for (let i = 0; i < QUOTES_MAX + 3; i += 1) result.current.add(`t${i}`, 'm1')
        })
        expect(result.current.quotes.length).toBeLessThanOrEqual(QUOTES_MAX)
    })
})
