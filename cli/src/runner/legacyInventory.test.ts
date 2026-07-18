import { describe, expect, it } from 'vitest'
import { buildLegacyInventory, renderLegacyInventoryReport } from './legacyInventory'

describe('legacy runner process inventory', () => {
    it('never marks an unjournaled process as killable', () => {
        const inventory = buildLegacyInventory([{
            pid: 4123,
            birthToken: 'boot:1234',
            pgid: 4123,
            provider: 'codex',
            hapiSessionId: 'hapi-session',
            nativeId: 'codex-thread',
            activeTurnEvidence: 'unknown',
            journalLaunchNonce: null
        }], [])

        expect(inventory).toEqual([expect.objectContaining({
            pid: 4123,
            ownerClassification: 'legacy-unjournaled',
            killable: false,
            reason: 'no matching ownership journal record'
        })])
    })

    it('renders only sanitized inventory fields and no argv, environment, or prompt bodies', () => {
        const report = renderLegacyInventoryReport(buildLegacyInventory([{
            pid: 5123,
            birthToken: 'boot:555',
            pgid: 5123,
            provider: 'claude',
            hapiSessionId: null,
            nativeId: null,
            activeTurnEvidence: 'none',
            journalLaunchNonce: null
        }], []))

        expect(report).toContain('PID 5123')
        expect(report).toContain('legacy-unjournaled')
        expect(report).not.toMatch(/argv|environment|prompt|message body/i)
    })
})
