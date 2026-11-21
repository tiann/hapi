import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('claude remote abort parks the queue', () => {
    const source = readFileSync(resolve(__dirname, 'claudeRemoteLauncher.ts'), 'utf8')

    it('stop parks the queue before aborting; switch/exit handoffs keep it', () => {
        const fn = source.slice(
            source.indexOf('private async abort('),
            source.indexOf('private async respawnBackoff(')
        )
        expect(fn).toContain('this.session.queue.reset({ preserveDispatchingReservations: true })')
        // Park BEFORE the controller abort: the reset must land while the
        // current attempt is still unwinding so the next attempt's
        // waitForMessagesAndGetAsString finds an empty queue.
        expect(fn.indexOf('this.session.queue.reset({ preserveDispatchingReservations: true })'))
            .toBeLessThan(fn.indexOf('this.abortController.abort()'))
        // Handoffs (switch to local / exit) pass parkQueue: false — the
        // local launcher owns the same session queue afterwards.
        expect(source).toContain("await this.abort({ parkQueue: false });")
    })
})
