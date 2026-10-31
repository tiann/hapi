import { describe, expect, it } from 'vitest'
import { ActivityError } from '@/modules/activity/activity'
import { parseUsageArgs } from './usage'

describe('parseUsageArgs', () => {
    it('reads the window and output format', () => {
        expect(parseUsageArgs([])).toEqual({ help: false, json: false })
        expect(parseUsageArgs(['--since', '7d', '--until=2026-10-08', '--json'])).toEqual({
            help: false, json: true, since: '7d', until: '2026-10-08'
        })
        expect(parseUsageArgs(['-h']).help).toBe(true)
    })

    it('rejects anything it doesn\'t know', () => {
        expect(() => parseUsageArgs(['--since'])).toThrow(ActivityError)
        expect(() => parseUsageArgs(['today'])).toThrow(ActivityError)
    })
})
