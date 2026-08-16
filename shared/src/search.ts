/** Whether a search query should be interpreted as a wildcard pattern. */
export function isWildcardSearch(query: string): boolean {
    return query.includes('*') || query.includes('?')
}

function matchesWildcard(value: string, pattern: string): boolean {
    const input = Array.from(value.toLowerCase())
    const tokens = Array.from(pattern.toLowerCase())
    let inputIndex = 0
    let tokenIndex = 0
    let starIndex = -1
    let retryInputIndex = 0

    while (inputIndex < input.length) {
        const token = tokens[tokenIndex]
        if (token !== undefined && (token === '?' || token === input[inputIndex])) {
            inputIndex++
            tokenIndex++
        } else if (token === '*') {
            starIndex = tokenIndex++
            retryInputIndex = inputIndex
        } else if (starIndex >= 0) {
            tokenIndex = starIndex + 1
            inputIndex = ++retryInputIndex
        } else {
            return false
        }
    }

    while (tokens[tokenIndex] === '*') {
        tokenIndex++
    }
    return tokenIndex === tokens.length
}

/** Match a value using the existing substring behavior or supported wildcards. */
export function matchesSearchQuery(value: string, query: string): boolean {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) return true

    if (!isWildcardSearch(normalizedQuery)) {
        return value.toLowerCase().includes(normalizedQuery.toLowerCase())
    }

    return matchesWildcard(value, normalizedQuery)
}

function escapeRipgrepGlobSyntax(pattern: string): string {
    let escaped = ''
    for (const [index, character] of Array.from(pattern).entries()) {
        if (character === '\\' || character === '[' || character === ']' || character === '{' || character === '}') {
            escaped += `\\${character}`
        } else if (index === 0 && character === '!') {
            escaped += '\\!'
        } else {
            escaped += character
        }
    }
    return escaped
}

/** Build a conservative ripgrep glob for plain-text file-search prefiltering. */
export function toSearchGlob(query: string): string {
    const normalizedQuery = query.trim()
    const pattern = isWildcardSearch(normalizedQuery) ? normalizedQuery : `*${normalizedQuery}*`
    return escapeRipgrepGlobSyntax(pattern)
}
