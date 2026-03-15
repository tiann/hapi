import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { FileIcon } from './FileIcon'

describe('FileIcon', () => {
    it('renders file icon for text files', () => {
        const { container } = render(<FileIcon fileName="test.txt" />)
        expect(container.querySelector('svg')).toBeInTheDocument()
    })

    it('renders file icon for javascript files', () => {
        const { container } = render(<FileIcon fileName="app.js" />)
        expect(container.querySelector('svg')).toBeInTheDocument()
    })

    it('renders file icon for typescript files', () => {
        const { container } = render(<FileIcon fileName="component.tsx" />)
        expect(container.querySelector('svg')).toBeInTheDocument()
    })

    it('renders file icon for image files', () => {
        const { container } = render(<FileIcon fileName="photo.png" />)
        expect(container.querySelector('svg')).toBeInTheDocument()
    })

    it('renders file icon for unknown file types', () => {
        const { container } = render(<FileIcon fileName="unknown.xyz" />)
        expect(container.querySelector('svg')).toBeInTheDocument()
    })

    it('renders file icon without extension', () => {
        const { container } = render(<FileIcon fileName="README" />)
        expect(container.querySelector('svg')).toBeInTheDocument()
    })

    it('renders with custom size', () => {
        const { container } = render(<FileIcon fileName="test.txt" size={32} />)
        const svg = container.querySelector('svg')
        expect(svg).toHaveAttribute('width', '32')
        expect(svg).toHaveAttribute('height', '32')
    })
})
