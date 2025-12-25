import { timingSafeEqual } from 'node:crypto'

export function safeCompareStrings(a: string | null | undefined, b: string | null | undefined): boolean {
    if (a == null || b == null) {
        return false
    }
    const bufA = Buffer.from(a, 'utf8')
    const bufB = Buffer.from(b, 'utf8')
    if (bufA.length !== bufB.length) {
        return false
    }
    return timingSafeEqual(bufA, bufB)
}
