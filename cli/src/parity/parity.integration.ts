import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { corpus, names, repo, run, testTimeout } from './run'

const candidate = process.env.HAPI_PARITY_WRAPPER_BIN

describe.each(names)('%s', name => {
    const golden = JSON.parse(readFileSync(join(corpus, name, 'golden.ts.json'), 'utf8'))
    it('matches the wrapper wire transcript and web decoding', async () => {
        expect(await run(name)).toEqual(golden)
    }, testTimeout)
    if (candidate) {
        it('matches the same golden with the supplied wrapper', async () => {
            expect(await run(name, resolve(repo, candidate))).toEqual(golden)
        }, testTimeout)
    }
})
