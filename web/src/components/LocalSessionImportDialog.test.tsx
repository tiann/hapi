import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocalSessionImportDialog } from './LocalSessionImportDialog'
import type { LocalSessionListItem } from '@/lib/localSessionImport'

vi.mock('@/components/ui/dialog', async (importOriginal) => await importOriginal())
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

const labels = {
    title: 'Import sessions',
    description: 'Pick local sessions',
    concurrentWarning: 'Careful with concurrent processes',
    loading: 'Scanning…',
    empty: 'Nothing here',
    selectedCount: '{n} selected',
    clearAll: 'Clear all',
    selectAll: 'Select all',
    allDirectories: 'All directories',
    search: 'Search',
    imported: 'Imported',
    needsAttention: 'Needs attention',
    messages: 'messages',
    importing: 'Importing…',
    confirm: 'Import',
    cancel: 'Cancel'
}

function session(overrides: Partial<LocalSessionListItem> = {}): LocalSessionListItem {
    return {
        id: 'pi-1',
        title: 'Pi session',
        lastUserMessage: 'hello there',
        cwd: '/tmp/project',
        file: '/tmp/pi-1.jsonl',
        modifiedAt: 1_700_000_000_000,
        messageCount: 3,
        model: 'gemini-3.8-flash',
        hapiSessionId: 'hapi-existing',
        ...overrides
    }
}

describe('LocalSessionImportDialog', () => {
    it('renders flattened flavor fields, selection count and confirms with selected ids', async () => {
        const onConfirm = vi.fn().mockResolvedValue(undefined)
        render(
            <LocalSessionImportDialog
                isOpen
                onClose={() => {}}
                sessions={[session(), session({ id: 'pi-2', title: 'Second session', cwd: '/tmp/other', hapiSessionId: undefined })]}
                labels={labels}
                onConfirm={onConfirm}
                isPending={false}
                isLoading={false}
            />
        )
        expect(screen.getByText('Pi session')).toBeTruthy()
        expect(screen.getAllByText('Imported').length).toBe(1)
        fireEvent.click(screen.getByText('Pi session').closest('label') as HTMLLabelElement)
        fireEvent.click(screen.getByRole('button', { name: 'Import' }))
        await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(['pi-1']))
    })

    it('filters by directory and search text', () => {
        render(
            <LocalSessionImportDialog
                isOpen
                onClose={() => {}}
                sessions={[session(), session({ id: 'pi-2', title: 'Other project', cwd: '/tmp/other' })]}
                labels={labels}
                onConfirm={vi.fn()}
                isPending={false}
                isLoading={false}
            />
        )
        fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'other project' } })
        expect(screen.getByText('Other project')).toBeTruthy()
        expect(screen.queryByText('Pi session')).toBeNull()
    })

    it('keeps the selection and search while open when the session list refreshes', async () => {
        const onConfirm = vi.fn().mockResolvedValue(undefined)
        const { rerender } = render(
            <LocalSessionImportDialog
                isOpen
                onClose={() => {}}
                sessions={[session()]}
                labels={labels}
                onConfirm={onConfirm}
                isPending={false}
                isLoading={false}
            />
        )
        fireEvent.click(screen.getByText('Pi session').closest('label') as HTMLLabelElement)
        fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'hello' } })

        // A background refresh lands while the dialog stays open: the
        // directories list changes, which must not wipe the in-progress picks.
        rerender(
            <LocalSessionImportDialog
                isOpen
                onClose={() => {}}
                sessions={[session(), session({ id: 'pi-2', title: 'Second session', cwd: '/tmp/other' })]}
                labels={labels}
                onConfirm={onConfirm}
                isPending={false}
                isLoading={false}
            />
        )
        expect((screen.getByPlaceholderText('Search') as HTMLInputElement).value).toBe('hello')
        fireEvent.click(screen.getByRole('button', { name: 'Import' }))
        await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(['pi-1']))
    })

    it('filters to the current work directory once the first scan arrives', async () => {
        const onConfirm = vi.fn().mockResolvedValue(undefined)
        const props = {
            isOpen: true,
            onClose: () => {},
            labels,
            currentWorkDirectory: '/tmp/project',
            onConfirm,
            isPending: false
        }
        // The dialog opens while the scan is still running.
        const { rerender } = render(<LocalSessionImportDialog {...props} sessions={[]} isLoading />)
        const scanned = [
            session({ hapiSessionId: undefined }),
            session({ id: 'pi-2', title: 'Other project session', cwd: '/tmp/other', hapiSessionId: undefined })
        ]
        rerender(<LocalSessionImportDialog {...props} sessions={scanned} isLoading={false} />)

        expect(screen.queryByText('Other project session')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
        fireEvent.click(screen.getByRole('button', { name: 'Import' }))
        await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(['pi-1']))
    })

    it('keeps a directory filter the user changed when the list refreshes', () => {
        const props = {
            isOpen: true,
            onClose: () => {},
            labels,
            currentWorkDirectory: '/tmp/project',
            onConfirm: vi.fn(),
            isPending: false,
            isLoading: false
        }
        const scanned = [
            session({ hapiSessionId: undefined }),
            session({ id: 'pi-2', title: 'Other project session', cwd: '/tmp/other', hapiSessionId: undefined })
        ]
        const { rerender } = render(<LocalSessionImportDialog {...props} sessions={scanned} />)
        expect(screen.queryByText('Other project session')).toBeNull()

        fireEvent.change(screen.getByDisplayValue('/tmp/project'), { target: { value: '__all__' } })
        expect(screen.getByText('Other project session')).toBeTruthy()

        rerender(<LocalSessionImportDialog {...props} sessions={[...scanned, session({ id: 'pi-3', title: 'Newer session', hapiSessionId: undefined })]} />)
        expect(screen.getByText('Other project session')).toBeTruthy()
        expect(screen.getByText('Newer session')).toBeTruthy()
    })

    it('shows the loading and empty states', () => {
        const { rerender } = render(
            <LocalSessionImportDialog
                isOpen
                onClose={() => {}}
                sessions={[]}
                labels={labels}
                onConfirm={vi.fn()}
                isPending={false}
                isLoading
            />
        )
        expect(screen.getByText('Scanning…')).toBeTruthy()
        rerender(
            <LocalSessionImportDialog
                isOpen
                onClose={() => {}}
                sessions={[]}
                labels={labels}
                onConfirm={vi.fn()}
                isPending={false}
                isLoading={false}
            />
        )
        expect(screen.getByText('Nothing here')).toBeTruthy()
    })
})