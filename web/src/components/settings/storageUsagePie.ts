export type StorageUsageSliceKey = 'database' | 'wal' | 'shm'

export type StorageUsageBytes = {
    databaseBytes: number
    walBytes: number
    shmBytes: number
}

export type StorageUsageSlice = {
    key: StorageUsageSliceKey
    bytes: number
    percent: number
    startAngle: number
    endAngle: number
}

const SLICE_ORDER: StorageUsageSliceKey[] = ['database', 'wal', 'shm']
const FULL_CIRCLE = 360
/** Start at 12 o'clock so the first slice reads top-heavy on mobile. */
const START_ANGLE = -90

function bytesForKey(usage: StorageUsageBytes, key: StorageUsageSliceKey): number {
    if (key === 'database') return usage.databaseBytes
    if (key === 'wal') return usage.walBytes
    return usage.shmBytes
}

export function buildStorageUsageSlices(usage: StorageUsageBytes): StorageUsageSlice[] {
    const entries = SLICE_ORDER
        .map((key) => {
            const raw = bytesForKey(usage, key)
            return { key, bytes: Number.isFinite(raw) && raw > 0 ? raw : 0 }
        })
        .filter((entry) => entry.bytes > 0)

    const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    if (total <= 0) return []

    let cursor = START_ANGLE
    return entries.map((entry, index) => {
        const isLast = index === entries.length - 1
        const endAngle = isLast
            ? START_ANGLE + FULL_CIRCLE
            : cursor + (entry.bytes / total) * FULL_CIRCLE
        const slice: StorageUsageSlice = {
            key: entry.key,
            bytes: entry.bytes,
            percent: Math.round((entry.bytes / total) * 1000) / 10,
            startAngle: cursor,
            endAngle,
        }
        cursor = endAngle
        return slice
    })
}

export function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number): { x: number; y: number } {
    const radians = (angleDeg * Math.PI) / 180
    return {
        x: cx + radius * Math.cos(radians),
        y: cy + radius * Math.sin(radians),
    }
}

export function describeDonutArc(
    cx: number,
    cy: number,
    innerRadius: number,
    outerRadius: number,
    startAngle: number,
    endAngle: number,
): string {
    // Prefer raw delta: (end - start) % 360 collapses a full 360° sweep to 0.
    const sweep = endAngle - startAngle
    if (sweep < 0.001) return ''

    // Full circle: SVG arc with identical start/end is ambiguous; use two half arcs.
    if (sweep >= FULL_CIRCLE - 0.001) {
        const mid = startAngle + 180
        const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle)
        const outerMid = polarToCartesian(cx, cy, outerRadius, mid)
        const outerEnd = polarToCartesian(cx, cy, outerRadius, endAngle)
        const innerEnd = polarToCartesian(cx, cy, innerRadius, endAngle)
        const innerMid = polarToCartesian(cx, cy, innerRadius, mid)
        const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle)
        return [
            `M ${outerStart.x} ${outerStart.y}`,
            `A ${outerRadius} ${outerRadius} 0 1 1 ${outerMid.x} ${outerMid.y}`,
            `A ${outerRadius} ${outerRadius} 0 1 1 ${outerEnd.x} ${outerEnd.y}`,
            `L ${innerEnd.x} ${innerEnd.y}`,
            `A ${innerRadius} ${innerRadius} 0 1 0 ${innerMid.x} ${innerMid.y}`,
            `A ${innerRadius} ${innerRadius} 0 1 0 ${innerStart.x} ${innerStart.y}`,
            'Z',
        ].join(' ')
    }

    const largeArc = sweep > 180 ? 1 : 0
    const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle)
    const outerEnd = polarToCartesian(cx, cy, outerRadius, endAngle)
    const innerEnd = polarToCartesian(cx, cy, innerRadius, endAngle)
    const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle)

    return [
        `M ${outerStart.x} ${outerStart.y}`,
        `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
        `L ${innerEnd.x} ${innerEnd.y}`,
        `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
        'Z',
    ].join(' ')
}

export function formatStoragePercent(percent: number): string {
    if (!Number.isFinite(percent)) return '0%'
    const rounded = Math.round(percent * 10) / 10
    return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`
}
