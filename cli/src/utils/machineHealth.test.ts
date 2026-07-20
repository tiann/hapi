import { describe, expect, it } from 'vitest'
import {
    collectMachineHealth,
    readDarwinMemoryUsedPercent,
    readLinuxMemoryUsedPercent,
    resetMachineHealthSamplerForTests
} from './machineHealth'

describe('readLinuxMemoryUsedPercent', () => {
    it('uses MemAvailable, not MemFree, so page cache does not read as pressure', () => {
        const meminfo = `
MemTotal:       32793696 kB
MemFree:          578248 kB
MemAvailable:   18312444 kB
Buffers:         1196580 kB
Cached:          9758076 kB
`.trim()

        expect(readLinuxMemoryUsedPercent(meminfo)).toBe(44)
    })
})

describe('readDarwinMemoryUsedPercent', () => {
    it('reports App+Wired+Compressed used memory, not total-minus-free (real Apple Silicon capture)', () => {
        // Verbatim `vm_stat` capture from a 16GB Mac mini (M-series, macOS 26.4, hw.memsize
        // 17179869184). `top` reported the same moment as "15G used (1952M wired, 5204M
        // compressor)"; anonymous 370327 pages ≈ 5.65GB App Memory. Activity Monitor's
        // "Memory Used" = App + Wired + Compressed ≈ 12.6GB → 79%.
        // The pre-fix path (`total - os.freemem()`) reported 99% here and drove the tooltip to
        // "High pressure — avoid spawning more here", because os.freemem() counts reclaimable
        // file cache as used. Summing only anonymous + wired + compressor yields 79%, matching
        // the number a user sees in Activity Monitor.
        const vmStat = `
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               15078.
Pages active:                            269344.
Pages inactive:                          269559.
Pages speculative:                         1623.
Pages throttled:                              0.
Pages wired down:                        124928.
Pages purgeable:                           6245.
"Translation faults":                6794924000.
Pages copy-on-write:                  151784964.
Pages zero filled:                   6137372590.
Pages reactivated:                     57500663.
Pages purged:                          11350044.
File-backed pages:                       170199.
Anonymous pages:                         370327.
Pages stored in compressor:              785407.
Pages occupied by compressor:            333030.
Decompressions:                        49937944.
Compressions:                          60303007.
Pageins:                               30419969.
Pageouts:                                124211.
Swapins:                                    288.
Swapouts:                                 12228.
`.trim()

        const totalBytes = 17179869184
        expect(readDarwinMemoryUsedPercent(vmStat, totalBytes)).toBe(79)
    })

    it('parses page size from the header instead of hardcoding it (Intel, 4KB pages)', () => {
        const vmStat = `
Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                               48576.
Pages active:                             900000.
Pages inactive:                           900000.
Pages speculative:                       100000.
Pages throttled:                               0.
Pages wired down:                         200000.
Pages purgeable:                            1000.
Anonymous pages:                         800000.
Pages occupied by compressor:             48576.
`.trim()

        // 8GB total (2097152 pages of 4096B), chosen so anonymous+wired+compressor pages ==
        // exactly half of total pages — verifies the header page size is used, not hardcoded.
        const totalBytes = 8589934592
        expect(readDarwinMemoryUsedPercent(vmStat, totalBytes)).toBe(50)
    })

    it('returns undefined when a required page count is missing, so callers fall back', () => {
        // Valid header and two of the three required counts present, but "Anonymous pages" is
        // absent — must fail safe to the caller's os.freemem() path, not compute from partial data.
        const vmStat = `
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages wired down:                        124928.
Pages occupied by compressor:            333030.
`.trim()

        expect(readDarwinMemoryUsedPercent(vmStat, 17179869184)).toBeUndefined()
    })

    it('returns undefined for entirely unparseable input', () => {
        expect(readDarwinMemoryUsedPercent('not a vm_stat output at all', 17179869184)).toBeUndefined()
    })

    it('returns undefined when totalBytes is not positive', () => {
        const vmStat = `
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages inactive:                           150000.
Pages speculative:                          9125.
`.trim()

        expect(readDarwinMemoryUsedPercent(vmStat, 0)).toBeUndefined()
    })

    it('falls back (undefined) when the page-size header is missing instead of guessing 4096', () => {
        // Required page counts are all present, but no "page size of N bytes" header. Guessing
        // 4096 would 4x-underestimate used bytes on Apple Silicon and re-introduce the
        // false-high-pressure bug, so this must fail safe to the caller's os.freemem() path.
        const vmStat = `
Pages wired down:                        124928.
Anonymous pages:                         370327.
Pages occupied by compressor:            333030.
`.trim()

        expect(readDarwinMemoryUsedPercent(vmStat, 17179869184)).toBeUndefined()
    })
})

describe('collectMachineHealth', () => {
    it('returns schema-valid health with memory, uptime, and cpu count', () => {
        resetMachineHealthSamplerForTests()
        const health = collectMachineHealth(1_700_000_000_000)
        expect(health.collectedAt).toBe(1_700_000_000_000)
        expect(health.cpuCount).toBeGreaterThan(0)
        expect(health.memoryPercent).toBeGreaterThanOrEqual(0)
        expect(health.memoryPercent).toBeLessThanOrEqual(100)
        expect(health.uptimeSeconds).toBeGreaterThan(0)
    })

    it('computes cpu percent after a second sample', async () => {
        resetMachineHealthSamplerForTests()
        collectMachineHealth()
        await new Promise((resolve) => setTimeout(resolve, 50))
        const second = collectMachineHealth()
        if (second.cpuPercent !== undefined) {
            expect(second.cpuPercent).toBeGreaterThanOrEqual(0)
            expect(second.cpuPercent).toBeLessThanOrEqual(100)
        }
    })
})
