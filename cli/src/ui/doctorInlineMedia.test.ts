import { describe, expect, it } from 'vitest'
import {
    formatInlineMediaCommand,
    inlineMediaHelperScriptPath,
    shellSingleQuote,
} from './doctorInlineMedia'

describe('doctorInlineMedia', () => {
    it('formatInlineMediaCommand uses repo scripts path', () => {
        const script = inlineMediaHelperScriptPath()
        expect(formatInlineMediaCommand(script, '341fe421')).toContain(
            "bun scripts/tooling/hapi-display-image.mjs '341fe421'"
        )
    })

    it('formatInlineMediaCommand shell-quotes paths with spaces and metacharacters', () => {
        const cmd = formatInlineMediaCommand(
            '/tmp/my repo/cli/src/ui/doctorInlineMedia.ts',
            'abc12345',
            '/tmp/my pics/shot.png',
        )
        // scriptPath is cli/src/ui/... → repo root is three levels up (cli)
        expect(cmd).toContain("cd '/tmp/my repo/cli'")
        expect(cmd).toContain("'abc12345'")
        expect(cmd).toContain("'/tmp/my pics/shot.png'")
    })

    it('shellSingleQuote escapes embedded single quotes for POSIX', () => {
        expect(shellSingleQuote("it's")).toBe(`'it'"'"'s'`)
        expect(shellSingleQuote('$(echo hi)')).toBe("'$(echo hi)'")
    })
})
