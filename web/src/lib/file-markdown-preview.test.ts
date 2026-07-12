import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_MARKDOWN_PREVIEW_MODE,
    MARKDOWN_PREVIEW_MODE_STORAGE_KEY,
    getInitialMarkdownPreviewMode,
    isMarkdownFile,
    persistMarkdownPreviewMode,
} from './file-markdown-preview'

describe('file-markdown-preview helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('detects markdown file extensions', () => {
        expect(isMarkdownFile('README.md')).toBe(true)
        expect(isMarkdownFile('docs/guide/page.mdx')).toBe(true)
        expect(isMarkdownFile('src/file.ts')).toBe(false)
        expect(isMarkdownFile('noext')).toBe(false)
    })

    it('defaults to preview when storage is missing or invalid', () => {
        expect(getInitialMarkdownPreviewMode()).toBe(DEFAULT_MARKDOWN_PREVIEW_MODE)
        window.localStorage.setItem(MARKDOWN_PREVIEW_MODE_STORAGE_KEY, 'nope')
        expect(getInitialMarkdownPreviewMode()).toBe(DEFAULT_MARKDOWN_PREVIEW_MODE)
    })

    it('reads and persists a valid preview mode', () => {
        persistMarkdownPreviewMode('source')
        expect(getInitialMarkdownPreviewMode()).toBe('source')

        persistMarkdownPreviewMode('preview')
        expect(window.localStorage.getItem(MARKDOWN_PREVIEW_MODE_STORAGE_KEY)).toBeNull()
        expect(getInitialMarkdownPreviewMode()).toBe(DEFAULT_MARKDOWN_PREVIEW_MODE)
    })
})
