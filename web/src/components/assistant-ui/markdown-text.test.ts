import { describe, expect, it } from 'vitest'
import remarkBreaks from 'remark-breaks'
import { buildRemarkPlugins, MARKDOWN_PLUGINS } from './markdown-text'

describe('buildRemarkPlugins', () => {
    it('returns the default plugin set when breakSingleNewlines is not requested', () => {
        expect(buildRemarkPlugins({})).toEqual(MARKDOWN_PLUGINS)
        expect(buildRemarkPlugins({ breakSingleNewlines: false })).toEqual(MARKDOWN_PLUGINS)
    })

    it('appends remark-breaks when breakSingleNewlines is true', () => {
        const plugins = buildRemarkPlugins({ breakSingleNewlines: true })
        expect(plugins).toContain(remarkBreaks)
        for (const base of MARKDOWN_PLUGINS) {
            expect(plugins).toContain(base)
        }
    })
})
