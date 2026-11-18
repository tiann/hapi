import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('claude remote abort parks the queue', () => {
    const source = readFileSync(resolve(__dirname, 'claudeRemoteLauncher.ts'), 'utf8')

    it('abort() resets the session queue before aborting the controller', () => {
        const fn = source.slice(
            source.indexOf('private async abort(): Promise<void> {'),
            source.indexOf('private async respawnBackoff(')
        )
        expect(fn).toContain('this.session.queue.reset()')
        // Park BEFORE the controller abort: the reset must land while the
        // current attempt is still unwinding so the next attempt's
        // waitForMessagesAndGetAsString finds an empty queue.
        expect(fn.indexOf('this.session.queue.reset()'))
            .toBeLessThan(fn.indexOf('this.abortController.abort()'))
    })
})
