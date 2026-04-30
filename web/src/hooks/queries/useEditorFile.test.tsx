import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useEditorFile } from './useEditorFile'

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function base64Utf8(value: string): string {
    const bytes = new TextEncoder().encode(value)
    let binary = ''
    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }
    return btoa(binary)
}

describe('useEditorFile', () => {
    it('does not fetch when required inputs are missing', () => {
        const api = { readEditorFile: vi.fn() } as unknown as ApiClient

        const { result } = renderHook(
            () => useEditorFile(api, 'machine-1', null),
            { wrapper: createWrapper() }
        )

        expect(result.current.content).toBeNull()
        expect(result.current.error).toBeNull()
        expect(api.readEditorFile).not.toHaveBeenCalled()
    })

    it('reads and decodes base64 UTF-8 file content', async () => {
        const api = {
            readEditorFile: vi.fn(async () => ({ success: true, content: base64Utf8('hello tiếng Việt') }))
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useEditorFile(api, 'machine-1', '/repo/README.md'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.content).toBe('hello tiếng Việt')
        })
        expect(result.current.error).toBeNull()
        expect(api.readEditorFile).toHaveBeenCalledWith('machine-1', '/repo/README.md')
    })

    it('treats empty file content as a valid successful read', async () => {
        const api = {
            readEditorFile: vi.fn(async () => ({ success: true, content: '', size: 0 }))
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useEditorFile(api, 'machine-1', '/repo/empty.ts'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.content).toBe('')
        })
        expect(result.current.error).toBeNull()
    })

    it('surfaces read failures', async () => {
        const api = {
            readEditorFile: vi.fn(async () => ({ success: false, error: 'Cannot read binary file' }))
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useEditorFile(api, 'machine-1', '/repo/image.png'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.error).toBe('Cannot read binary file')
        })
        expect(result.current.content).toBeNull()
    })

    it('reports invalid base64 content', async () => {
        const api = {
            readEditorFile: vi.fn(async () => ({ success: true, content: '%%%not-base64%%%' }))
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useEditorFile(api, 'machine-1', '/repo/bad.txt'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.error).toBe('Failed to decode file content')
        })
        expect(result.current.content).toBeNull()
    })
})
