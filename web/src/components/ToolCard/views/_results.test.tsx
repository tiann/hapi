import { describe, expect, it } from 'vitest'
import { extractTextFromResult, getMutationResultRenderMode, getToolResultViewComponent } from '@/components/ToolCard/views/_results'

describe('extractTextFromResult', () => {
    it('returns string directly', () => {
        expect(extractTextFromResult('hello')).toBe('hello')
    })

    it('extracts text from content block array', () => {
        const result = [{ type: 'text', text: 'File created successfully' }]
        expect(extractTextFromResult(result)).toBe('File created successfully')
    })

    it('joins multiple content blocks', () => {
        const result = [
            { type: 'text', text: 'Line 1' },
            { type: 'text', text: 'Line 2' }
        ]
        expect(extractTextFromResult(result)).toBe('Line 1\nLine 2')
    })

    it('extracts from object with content field', () => {
        expect(extractTextFromResult({ content: 'done' })).toBe('done')
    })

    it('extracts from object with text field', () => {
        expect(extractTextFromResult({ text: 'done' })).toBe('done')
    })

    it('extracts from object with output field', () => {
        expect(extractTextFromResult({ output: 'ok' })).toBe('ok')
    })

    it('extracts from object with error field', () => {
        expect(extractTextFromResult({ error: 'not found' })).toBe('not found')
    })

    it('returns null for null/undefined', () => {
        expect(extractTextFromResult(null)).toBeNull()
        expect(extractTextFromResult(undefined)).toBeNull()
    })

    it('strips tool_use_error tags', () => {
        const result = '<tool_use_error>Permission denied</tool_use_error>'
        expect(extractTextFromResult(result)).toBe('Permission denied')
    })
})

describe('getMutationResultRenderMode', () => {
    it('uses auto mode for short single-line success messages', () => {
        const result = getMutationResultRenderMode('Successfully wrote to /path/file.ts', 'completed')
        expect(result.mode).toBe('auto')
        expect(result.language).toBeUndefined()
    })

    it('uses auto mode for 3 lines or fewer', () => {
        const text = 'Line 1\nLine 2\nLine 3'
        const result = getMutationResultRenderMode(text, 'completed')
        expect(result.mode).toBe('auto')
    })

    it('uses code mode for multiline content (>3 lines) to avoid markdown mis-parsing', () => {
        const bashScript = '#!/bin/bash\n# Batch download\nset -e\ndownload() {\n  echo "downloading"\n}'
        const result = getMutationResultRenderMode(bashScript, 'completed')
        expect(result.mode).toBe('code')
        expect(result.language).toBe('text')
    })

    it('uses code mode for error state regardless of line count', () => {
        const result = getMutationResultRenderMode('Error: file not found', 'error')
        expect(result.mode).toBe('code')
        expect(result.language).toBe('text')
    })

    it('uses code mode for multiline error', () => {
        const text = 'Error\nStack trace:\n  at foo\n  at bar\n  at baz'
        const result = getMutationResultRenderMode(text, 'error')
        expect(result.mode).toBe('code')
    })
})

describe('getToolResultViewComponent registry', () => {
    it('uses the same view for Write, Edit, MultiEdit, NotebookEdit', () => {
        const writeView = getToolResultViewComponent('Write')
        const editView = getToolResultViewComponent('Edit')
        const multiEditView = getToolResultViewComponent('MultiEdit')
        const notebookEditView = getToolResultViewComponent('NotebookEdit')
        expect(writeView).toBe(editView)
        expect(editView).toBe(multiEditView)
        expect(multiEditView).toBe(notebookEditView)
    })

    it('returns GenericResultView for mcp__ prefixed tools', () => {
        const mcpView = getToolResultViewComponent('mcp__test__tool')
        const unknownView = getToolResultViewComponent('SomeUnknownTool')
        // Both should fall back to GenericResultView
        expect(mcpView).toBe(unknownView)
    })
})
