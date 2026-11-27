import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionFolderDialog } from './SessionFolders'

describe('SessionFolderDialog', () => {
    it('distinguishes literal folder names from nested and unfiled destinations', () => {
        render(<I18nProvider><SessionFolderDialog
            mode="move"
            folderId={null}
            folders={[
                { id: 'work', name: 'Work', parentId: null },
                { id: 'nested', name: 'Notes', parentId: 'work' },
                { id: 'root', name: 'Work / Notes', parentId: null },
                { id: 'literal', name: 'No folder', parentId: null }
            ]}
            onClose={vi.fn()}
            onSubmit={vi.fn()}
        /></I18nProvider>)

        expect(screen.getByRole('option', { name: 'Work / Notes', exact: true })).toHaveValue('nested')
        expect(screen.getByRole('option', { name: '"Work / Notes"', exact: true })).toHaveValue('root')
        expect(screen.getByRole('option', { name: 'No folder', exact: true })).toHaveValue('')
        expect(screen.getByRole('option', { name: '"No folder"', exact: true })).toHaveValue('literal')
    })
})
