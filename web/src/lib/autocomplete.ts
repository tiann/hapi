/** Yen aliases emitted by Chinese IMEs in place of ASCII `$`. */
export const FULL_WIDTH_YEN_SIGN = '\uFFE5'
export const NARROW_YEN_SIGN = '\u00A5'

export const DEFAULT_AUTOCOMPLETE_PREFIXES = [
    '@',
    '/',
    '$',
    FULL_WIDTH_YEN_SIGN,
    NARROW_YEN_SIGN,
] as const

const SKILL_AUTOCOMPLETE_PREFIXES = [
    '$',
    FULL_WIDTH_YEN_SIGN,
    NARROW_YEN_SIGN,
] as const
const YEN_SIGN_PREFIXES = [FULL_WIDTH_YEN_SIGN, NARROW_YEN_SIGN] as const

export function isSkillAutocompleteQuery(query: string): boolean {
    return SKILL_AUTOCOMPLETE_PREFIXES.some((prefix) => query.startsWith(prefix))
}

export function normalizeSkillAutocompleteQuery(query: string): string {
    // Keep `$skill-name` as the only syntax passed to the existing skill provider.
    const yenPrefix = YEN_SIGN_PREFIXES.find((prefix) => query.startsWith(prefix))
    if (yenPrefix) {
        return `$${query.slice(yenPrefix.length)}`
    }
    return query
}
