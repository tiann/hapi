import { describe, expect, it } from 'vitest'
import { getAllowedHosts } from './viteAllowedHosts'

describe('getAllowedHosts', () => {
    it('includes the public hapidev host', () => {
        expect(getAllowedHosts()).toContain('hapidev.duxiaoxiong.top')
    })
})
