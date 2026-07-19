/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { WorkspaceBrowser } from './WorkspaceBrowser'

afterEach(() => cleanup())

function renderBrowser() {
    const api = {
        listHostDirectory: vi.fn(async () => ({ success: true, path: '/workspace', entries: [] })),
        inspectHostGit: vi.fn(async () => ({ success: false, error: 'No Git repository found' })),
        uploadHostFile: vi.fn(async () => ({ success: true, path: '/workspace/notes.txt', size: 5 })),
        startHostOperation: vi.fn(async () => ({
            success: true,
            operation: {
                id: '11111111-1111-4111-8111-111111111111',
                domain: 'file',
                kind: 'create-file',
                status: 'queued',
                progress: 0,
                createdAt: 1
            }
        })),
        getHostOperation: vi.fn(async () => ({
            success: true,
            operation: {
                id: '11111111-1111-4111-8111-111111111111',
                domain: 'file',
                kind: 'create-file',
                status: 'succeeded',
                progress: 1,
                createdAt: 1,
                finishedAt: 2
            }
        })),
        cancelHostOperation: vi.fn()
    }
    const machine = {
        id: 'machine-1',
        active: true,
        metadata: {
            host: 'workstation',
            workspaceRoots: ['/workspace']
        }
    } as Machine

    render(
        <I18nProvider>
            <WorkspaceBrowser
                api={api as unknown as ApiClient}
                machines={[machine]}
                machinesLoading={false}
                onStartSession={vi.fn()}
            />
        </I18nProvider>
    )
    return api
}

describe('WorkspaceBrowser host operations', () => {
    it('creates a file through the in-app action dialog', async () => {
        const api = renderBrowser()
        await waitFor(() => expect(api.listHostDirectory).toHaveBeenCalledWith('machine-1', '/workspace', false))

        fireEvent.click(screen.getByRole('button', { name: 'New file' }))
        const dialog = screen.getByRole('dialog')
        fireEvent.change(within(dialog).getByLabelText('File name'), { target: { value: 'notes.md' } })
        fireEvent.click(within(dialog).getByRole('button', { name: 'New file' }))

        await waitFor(() => expect(api.startHostOperation).toHaveBeenCalledWith('machine-1', {
            domain: 'file',
            operation: { kind: 'create-file', path: '/workspace/notes.md' }
        }))
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('derives a clone folder and submits a structured Git operation', async () => {
        const api = renderBrowser()
        await waitFor(() => expect(api.listHostDirectory).toHaveBeenCalled())

        fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
        const dialog = screen.getByRole('dialog')
        fireEvent.change(within(dialog).getByLabelText('GitHub repository or Git URL'), {
            target: { value: 'owner/repository.git' }
        })
        expect(within(dialog).getByLabelText('Destination folder')).toHaveValue('repository')
        fireEvent.click(within(dialog).getByRole('button', { name: 'Clone repository' }))

        await waitFor(() => expect(api.startHostOperation).toHaveBeenCalledWith('machine-1', {
            domain: 'git',
            operation: {
                kind: 'clone',
                source: 'owner/repository.git',
                destination: '/workspace/repository'
            }
        }))
    })

    it('uploads a selected file to the current workspace directory', async () => {
        const api = renderBrowser()
        await waitFor(() => expect(api.listHostDirectory).toHaveBeenCalled())
        const file = new File([], 'notes.txt', { type: 'text/plain' })
        Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([104, 101, 108, 108, 111]).buffer })

        const input = screen.getAllByLabelText('Upload file').find((element) => element instanceof HTMLInputElement)
        expect(input).toBeDefined()
        fireEvent.change(input as HTMLInputElement, { target: { files: [file] } })

        await waitFor(() => expect(api.uploadHostFile).toHaveBeenCalledWith('machine-1', {
            directory: '/workspace',
            name: 'notes.txt',
            contentBase64: 'aGVsbG8=',
            conflict: 'new-copy'
        }))
    })
})
