import { describe, expect, it } from 'vitest'
import { consumeManagedLaunchArgs } from './managedLaunchArgs'

describe('consumeManagedLaunchArgs', () => {
    it('retains ownership in process environment but removes internal flags from provider routing', () => {
        const env: NodeJS.ProcessEnv = {}
        const args = consumeManagedLaunchArgs([
            'codex', '--model', 'gpt-5.5',
            '--hapi-launch-nonce', 'launch-123',
            '--hapi-runner-instance', 'runner-456'
        ], env)

        expect(args).toEqual(['codex', '--model', 'gpt-5.5'])
        expect(env).toMatchObject({
            HAPI_LAUNCH_NONCE: 'launch-123',
            HAPI_RUNNER_INSTANCE_ID: 'runner-456'
        })
    })

    it('rejects partial or duplicate internal ownership flags', () => {
        expect(() => consumeManagedLaunchArgs(['codex', '--hapi-launch-nonce', 'only'], {})).toThrow('must appear exactly once')
        expect(() => consumeManagedLaunchArgs([
            'codex', '--hapi-launch-nonce', 'one', '--hapi-launch-nonce', 'two',
            '--hapi-runner-instance', 'runner'
        ], {})).toThrow('must appear exactly once')
    })

    it('clears inherited managed identity when this invocation has no ownership flags', () => {
        const env: NodeJS.ProcessEnv = {
            HAPI_LAUNCH_NONCE: 'stale-launch',
            HAPI_RUNNER_INSTANCE_ID: 'stale-runner'
        }
        expect(consumeManagedLaunchArgs(['codex'], env)).toEqual(['codex'])
        expect(env.HAPI_LAUNCH_NONCE).toBeUndefined()
        expect(env.HAPI_RUNNER_INSTANCE_ID).toBeUndefined()
    })
})
