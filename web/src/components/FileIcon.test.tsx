import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FileIcon, FolderIcon } from './FileIcon'

describe('FileIcon', () => {
    it('uses specific icons for common file types and config files', () => {
        render(
            <div>
                <FileIcon fileName="App.tsx" />
                <FileIcon fileName="package.json" />
                <FileIcon fileName="README.md" />
            </div>
        )

        expect(screen.getByRole('img', { name: 'TypeScript React file' })).toBeInTheDocument()
        expect(screen.getByRole('img', { name: 'Package manifest' })).toBeInTheDocument()
        expect(screen.getByRole('img', { name: 'Readme file' })).toBeInTheDocument()
    })

    it('uses specific icons for known folders', () => {
        render(
            <div>
                <FolderIcon folderName="src" />
                <FolderIcon folderName="components" />
            </div>
        )

        expect(screen.getByRole('img', { name: 'Source folder' })).toBeInTheDocument()
        expect(screen.getByRole('img', { name: 'Components folder' })).toBeInTheDocument()
    })
})
