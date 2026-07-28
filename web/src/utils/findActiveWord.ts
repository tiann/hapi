/**
 * Finds the active word at the cursor position that starts with one of the given prefixes
 * @param content The full text content
 * @param selection The current cursor position/selection
 * @param prefixes Array of prefix characters to look for (e.g., ['@', '/'])
 * @returns An object containing word info, or undefined if no prefixed word is found
 */

// Characters that stop the active word search (hard stops — do not cross).
const STOP_CHARACTERS = ['\n', ',', '(', ')', '[', ']', '{', '}', '<', '>', ';', '!', '?', '.']

/** Rich-composer mirror uses U+FFFC for session atoms — hard word boundary. */
const MENTION_MIRROR_CHAR = '\uFFFC'

function isHardStopChar(char: string): boolean {
    return char === MENTION_MIRROR_CHAR || STOP_CHARACTERS.includes(char)
}

function isPrefixBoundaryBefore(content: string, index: number): boolean {
    if (index === 0) return true
    const prev = content.charAt(index - 1)
    return prev === ' ' || prev === '\n' || prev === MENTION_MIRROR_CHAR
}

interface Selection {
    start: number
    end: number
}

export interface ActiveWord {
    word: string           // Full word from prefix to end (e.g., "@username")
    activeWord: string     // Part from prefix to cursor (e.g., "@use")
    offset: number         // Starting position of the word
    length: number         // Total length of the complete word
    activeLength: number   // Length from prefix to cursor
    endOffset: number      // Position where the word ends (offset + length)
}

function findActiveWordStart(
    content: string,
    selection: Selection,
    prefixes: string[]
): number {
    let startIndex = selection.start - 1
    let spaceIndex = -1
    let foundPrefix = false
    let prefixIndex = -1

    while (startIndex >= 0) {
        const char = content.charAt(startIndex)

        // Hard stops (newline / mention atom / punctuation) — never cross.
        if (isHardStopChar(char)) {
            if (foundPrefix) {
                return prefixIndex
            }
            return startIndex + 1
        }
        // Soft space boundary (same as historical textarea behavior).
        if (char === ' ') {
            if (foundPrefix) {
                return prefixIndex
            }
            if (spaceIndex >= 0) {
                return spaceIndex + 1
            }
            spaceIndex = startIndex
            startIndex--
            continue
        }
        // Prefix at a word boundary
        if (prefixes.includes(char) && isPrefixBoundaryBefore(content, startIndex)) {
            if (char === '@') {
                foundPrefix = true
                prefixIndex = startIndex
                return startIndex
            }
            return startIndex
        }
        startIndex--
    }

    // Reached beginning of text
    if (foundPrefix) {
        return prefixIndex
    }
    return (spaceIndex >= 0 ? spaceIndex : startIndex) + 1
}

function findActiveWordEnd(
    content: string,
    cursorPos: number,
    wordStartPos?: number
): number {
    let endIndex = cursorPos

    // Check if this is a file path (starts with @ and may contain /)
    let isFilePath = false
    if (wordStartPos !== undefined && wordStartPos >= 0 && wordStartPos < content.length) {
        isFilePath = content.charAt(wordStartPos) === '@'
    }

    while (endIndex < content.length) {
        const char = content.charAt(endIndex)

        // For file paths starting with @, don't stop at / or .
        if (isFilePath && (char === '/' || char === '.')) {
            endIndex++
            continue
        }

        if (char === ' ' || isHardStopChar(char)) {
            break
        }
        endIndex++
    }

    return endIndex
}

export function findActiveWord(
    content: string,
    selection: Selection,
    prefixes: string[] = ['@', '/']
): ActiveWord | undefined {
    // Only detect when cursor is at a single point (no text selected)
    if (selection.start !== selection.end) {
        return undefined
    }

    // Don't detect if cursor is at the very beginning
    if (selection.start === 0) {
        return undefined
    }

    const startIndex = findActiveWordStart(content, selection, prefixes)
    const activeWordPart = content.substring(startIndex, selection.end)

    // Check if the active word ends with a space - if so, no active word
    if (activeWordPart.endsWith(' ')) {
        return undefined
    }

    // Check if the word starts with one of our prefixes
    if (activeWordPart.length > 0) {
        const firstChar = activeWordPart.charAt(0)
        if (prefixes.includes(firstChar)) {
            // Find where the word ends after the cursor
            // Pass the start position to help determine if this is a file path
            const endIndex = findActiveWordEnd(content, selection.end, startIndex)
            const fullWord = content.substring(startIndex, endIndex)

            // Don't return just the prefix character alone
            if (activeWordPart.length === 1 && fullWord.length === 1) {
                return {
                    word: fullWord,
                    activeWord: activeWordPart,
                    offset: startIndex,
                    length: fullWord.length,
                    activeLength: activeWordPart.length,
                    endOffset: endIndex
                } // Return single prefix to show suggestions immediately
            }
            return {
                word: fullWord,
                activeWord: activeWordPart,
                offset: startIndex,
                length: fullWord.length,
                activeLength: activeWordPart.length,
                endOffset: endIndex
            }
        }
    }

    return undefined
}

/**
 * Extracts just the query part without the prefix
 * @param activeWord The active word including prefix
 * @returns The query string without prefix
 */
export function getActiveWordQuery(activeWord: string): string {
    if (activeWord.length > 1) {
        return activeWord.substring(1)
    }
    return ''
}
