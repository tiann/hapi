import { describe, expect, it } from 'vitest'
import { formatInlineMediaCommand, inlineMediaHelperScriptPath } from './doctorInlineMedia'

describe('doctorInlineMedia', () => {
    it('formatInlineMediaCommand uses repo scripts path', () => {
        const script = inlineMediaHelperScriptPath()
        expect(formatInlineMediaCommand(script, '341fe421')).toContain(
            'bun scripts/tooling/hapi-display-image.mjs 341fe421'
        )
    })
})
