import { describe, expect, it, vi } from 'vitest'
import { proveRecordedProcessGroupEmpty } from './startupAbsence'

describe('proveRecordedProcessGroupEmpty', () => {
    it('falls back to the launch pgid for legacy leases without a copied pgid', async () => {
        const readGroup = vi.fn(async () => ({ complete: true, members: [] }))

        await expect(proveRecordedProcessGroupEmpty({
            leasePgid: null,
            launchPgid: 4321,
            readGroup
        })).resolves.toBe(true)
        expect(readGroup).toHaveBeenCalledWith(4321)
    })

    it('refuses to infer group absence from missing pgid metadata', async () => {
        const readGroup = vi.fn(async () => ({ complete: true, members: [] }))

        await expect(proveRecordedProcessGroupEmpty({
            leasePgid: null,
            launchPgid: null,
            readGroup
        })).resolves.toBe(false)
        expect(readGroup).not.toHaveBeenCalled()
    })

    it('requires complete evidence for an empty recorded process group', async () => {
        await expect(proveRecordedProcessGroupEmpty({
            leasePgid: 4321,
            launchPgid: 9876,
            readGroup: async () => ({ complete: false, members: [] })
        })).resolves.toBe(false)
        await expect(proveRecordedProcessGroupEmpty({
            leasePgid: 4321,
            launchPgid: 9876,
            readGroup: async () => ({ complete: true, members: [{}] })
        })).resolves.toBe(false)
    })
})
