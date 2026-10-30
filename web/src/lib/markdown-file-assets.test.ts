import { describe, expect, it } from 'vitest'
import {
    getMarkdownImageMimeType,
    resolveMarkdownFileImage,
    resolveMarkdownFileLink,
} from './markdown-file-assets'

describe('markdown file assets', () => {
    it('resolves sibling links relative to the current Markdown file', () => {
        expect(resolveMarkdownFileLink('notes/notes-01.md', 'error-notes.md')).toEqual({
            kind: 'local',
            path: 'notes/error-notes.md',
        })
    })

    it('resolves nested relative image paths and normalizes dot segments', () => {
        expect(resolveMarkdownFileImage('notes/notes-01.md', './images/../images/page-001.png')).toEqual({
            kind: 'local',
            path: 'notes/images/page-001.png',
        })
    })

    it('rejects paths that escape the session root', () => {
        expect(resolveMarkdownFileLink('notes/notes-01.md', '../../secret.md')).toEqual({
            kind: 'inert',
            href: '../../secret.md',
        })
    })

    it('keeps safe absolute in-workspace paths as local targets', () => {
        expect(resolveMarkdownFileLink('/workspace/notes/notes-01.md', '/workspace/notes/error-notes.md', { workspacePath: '/workspace' })).toEqual({
            kind: 'local',
            path: '/workspace/notes/error-notes.md',
        })
    })

    it('keeps out-of-workspace absolute paths inert', () => {
        expect(resolveMarkdownFileLink('/workspace/notes/notes-01.md', '/etc/secret.md', { workspacePath: '/workspace' })).toEqual({
            kind: 'inert',
            href: '/etc/secret.md',
        })
    })

    it('rejects traversal beyond the root of an absolute current file path', () => {
        expect(resolveMarkdownFileLink('/workspace/notes/readme.md', '../../../secret.md', { workspacePath: '/workspace' })).toEqual({
            kind: 'inert',
            href: '../../../secret.md',
        })
    })

    it('recognizes Windows drive paths and applies workspace containment', () => {
        expect(resolveMarkdownFileLink('C:\\workspace\\notes\\notes-01.md', 'C:\\workspace\\notes\\error-notes.md', { workspacePath: 'C:\\workspace' })).toEqual({
            kind: 'local',
            path: 'C:/workspace/notes/error-notes.md',
        })
        expect(resolveMarkdownFileLink('C:\\workspace\\notes\\notes-01.md', 'C:\\Users\\other\\secret.md', { workspacePath: 'C:\\workspace' })).toEqual({
            kind: 'inert',
            href: 'C:\\Users\\other\\secret.md',
        })
    })

    it('passes HTTPS images through as remote targets', () => {
        expect(resolveMarkdownFileImage('notes/notes-01.md', 'https://example.com/page.png')).toEqual({
            kind: 'remote',
            href: 'https://example.com/page.png',
        })
    })

    it('preserves safe non-HTTP URI links for the shared link policy', () => {
        expect(resolveMarkdownFileLink('notes/notes-01.md', 'mailto:help@example.com')).toEqual({
            kind: 'uri',
            href: 'mailto:help@example.com',
        })
    })

    it('keeps anchors and known app routes navigable', () => {
        expect(resolveMarkdownFileLink('notes/notes-01.md', '#section')).toEqual({ kind: 'anchor', href: '#section' })
        expect(resolveMarkdownFileLink('notes/notes-01.md', '/settings')).toEqual({ kind: 'anchor', href: '/settings' })
    })

    it('maps supported image extensions to MIME types', () => {
        expect(getMarkdownImageMimeType('images/page-001.PNG')).toBe('image/png')
        expect(getMarkdownImageMimeType('images/animation.apng')).toBe('image/apng')
        expect(getMarkdownImageMimeType('images/scan.tif')).toBe('image/tiff')
        expect(getMarkdownImageMimeType('images/scan.tiff')).toBe('image/tiff')
        expect(getMarkdownImageMimeType('docs/readme.md')).toBeNull()
    })

    it('resolves image extensions declared in the MIME map', () => {
        expect(resolveMarkdownFileImage('notes/readme.md', 'images/animation.apng')).toEqual({
            kind: 'local',
            path: 'notes/images/animation.apng',
        })
    })
})
