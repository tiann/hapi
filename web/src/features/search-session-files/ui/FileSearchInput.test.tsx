import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { FileSearchInput } from './FileSearchInput'

vi.mock('@/hooks/queries/useSessionFileSearch', () => ({
    useSessionFileSearch: vi.fn()
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: {}
    })
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key
    })
}))

import { useSessionFileSearch } from '@/hooks/queries/useSessionFileSearch'

describe('FileSearchInput', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        cleanup()
    })

    it('renders search input', () => {
        vi.mocked(useSessionFileSearch).mockReturnValue({
            files: [],
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        render(
            <FileSearchInput
                sessionId="session-1"
            />
        )

        expect(screen.getByPlaceholderText('search.placeholder')).toBeInTheDocument()
    })

    it('uses custom placeholder when provided', () => {
        vi.mocked(useSessionFileSearch).mockReturnValue({
            files: [],
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        render(
            <FileSearchInput
                sessionId="session-1"
                placeholder="Custom placeholder"
            />
        )

        expect(screen.getByPlaceholderText('Custom placeholder')).toBeInTheDocument()
    })

    it('updates query on input change', async () => {
        vi.mocked(useSessionFileSearch).mockReturnValue({
            files: [],
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        render(
            <FileSearchInput
                sessionId="session-1"
            />
        )

        const input = screen.getByPlaceholderText('search.placeholder')
        fireEvent.change(input, { target: { value: 'test.ts' } })

        expect(input).toHaveValue('test.ts')
    })

    it('displays search results when query is not empty', async () => {
        const mockFiles = [
            { fullPath: '/src/test.ts' },
            { fullPath: '/src/test2.ts' }
        ]

        vi.mocked(useSessionFileSearch).mockReturnValue({
            files: mockFiles,
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        render(
            <FileSearchInput
                sessionId="session-1"
            />
        )

        const input = screen.getByPlaceholderText('search.placeholder')
        fireEvent.change(input, { target: { value: 'test' } })

        await waitFor(() => {
            expect(screen.getByText('/src/test.ts')).toBeInTheDocument()
            expect(screen.getByText('/src/test2.ts')).toBeInTheDocument()
        })
    })

    it('calls onResultSelect when clicking a result', async () => {
        const onResultSelect = vi.fn()
        const mockFiles = [
            { fullPath: '/src/test.ts' }
        ]

        vi.mocked(useSessionFileSearch).mockReturnValue({
            files: mockFiles,
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        render(
            <FileSearchInput
                sessionId="session-1"
                onResultSelect={onResultSelect}
            />
        )

        const input = screen.getByPlaceholderText('search.placeholder')
        fireEvent.change(input, { target: { value: 'test' } })

        const result = await screen.findByText('/src/test.ts')
        fireEvent.click(result)

        expect(onResultSelect).toHaveBeenCalledWith('/src/test.ts')
    })

    it('clears query after selecting a result', async () => {
        const mockFiles = [
            { fullPath: '/src/test.ts' }
        ]

        vi.mocked(useSessionFileSearch).mockReturnValue({
            files: mockFiles,
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        render(
            <FileSearchInput
                sessionId="session-1"
                onResultSelect={vi.fn()}
            />
        )

        const input = screen.getByPlaceholderText('search.placeholder') as HTMLInputElement
        fireEvent.change(input, { target: { value: 'test' } })

        const result = await screen.findByText('/src/test.ts')
        fireEvent.click(result)

        await waitFor(() => {
            expect(input.value).toBe('')
        })
    })

    it('shows loading indicator when searching', async () => {
        vi.mocked(useSessionFileSearch).mockReturnValue({
            files: [],
            isLoading: true,
            error: null,
            refetch: vi.fn()
        })

        render(
            <FileSearchInput
                sessionId="session-1"
            />
        )

        const input = screen.getByPlaceholderText('search.placeholder')
        fireEvent.change(input, { target: { value: 'test' } })

        expect(screen.getByText('search.loading')).toBeInTheDocument()
    })

    it('does not show results when query is empty', () => {
        const mockFiles = [
            { fullPath: '/src/test.ts' }
        ]

        vi.mocked(useSessionFileSearch).mockReturnValue({
            files: mockFiles,
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        render(
            <FileSearchInput
                sessionId="session-1"
            />
        )

        expect(screen.queryByText('/src/test.ts')).not.toBeInTheDocument()
    })

    it('does not show loading when query is empty', () => {
        vi.mocked(useSessionFileSearch).mockReturnValue({
            files: [],
            isLoading: true,
            error: null,
            refetch: vi.fn()
        })

        render(
            <FileSearchInput
                sessionId="session-1"
            />
        )

        expect(screen.queryByText('search.loading')).not.toBeInTheDocument()
    })
})
