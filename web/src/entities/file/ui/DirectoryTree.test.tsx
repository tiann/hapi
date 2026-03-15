import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DirectoryTree } from './DirectoryTree'
import type { ApiClient } from '@/api/client'
import type { ReactNode } from 'react'

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    })
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

describe('DirectoryTree', () => {
    let mockApi: ApiClient

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = {
            listSessionDirectory: vi.fn(),
        } as unknown as ApiClient
    })

    it('renders root directory', async () => {
        ;(mockApi.listSessionDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            entries: [
                { name: 'file.txt', type: 'file' },
                { name: 'folder', type: 'directory' },
            ],
        })

        render(
            <DirectoryTree
                api={mockApi}
                sessionId="session-123"
                rootLabel="Project"
                onOpenFile={vi.fn()}
            />,
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(screen.getByText('Project')).toBeInTheDocument()
        })
    })

    it('displays loading state', () => {
        ;(mockApi.listSessionDirectory as ReturnType<typeof vi.fn>).mockImplementation(
            () => new Promise(() => {}) // Never resolves
        )

        render(
            <DirectoryTree
                api={mockApi}
                sessionId="session-123"
                rootLabel="Project"
                onOpenFile={vi.fn()}
            />,
            { wrapper: createWrapper() }
        )

        // Should show skeleton loader
        const skeletons = document.querySelectorAll('.animate-pulse')
        expect(skeletons.length).toBeGreaterThan(0)
    })

    it('displays error state', async () => {
        ;(mockApi.listSessionDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: false,
            error: 'Directory not found',
        })

        render(
            <DirectoryTree
                api={mockApi}
                sessionId="session-123"
                rootLabel="Project"
                onOpenFile={vi.fn()}
            />,
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(screen.getByText(/Directory not found/i)).toBeInTheDocument()
        })
    })

    it('calls onOpenFile when file is clicked', async () => {
        const onOpenFile = vi.fn()

        ;(mockApi.listSessionDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            entries: [
                { name: 'test.txt', type: 'file' },
            ],
        })

        render(
            <DirectoryTree
                api={mockApi}
                sessionId="session-123"
                rootLabel="Project"
                onOpenFile={onOpenFile}
            />,
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(screen.getByText('test.txt')).toBeInTheDocument()
        })

        const fileButton = screen.getByText('test.txt').closest('button')
        if (fileButton) {
            fileButton.click()
            expect(onOpenFile).toHaveBeenCalledWith('test.txt')
        }
    })

    it('handles null api gracefully', () => {
        render(
            <DirectoryTree
                api={null}
                sessionId="session-123"
                rootLabel="Project"
                onOpenFile={vi.fn()}
            />,
            { wrapper: createWrapper() }
        )

        expect(screen.getAllByText('Project')[0]).toBeInTheDocument()
    })
})
