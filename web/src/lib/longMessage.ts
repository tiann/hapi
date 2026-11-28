const LONG_MESSAGE_THRESHOLD = 5000

export function isLongMessage(text: string): boolean {
    if (text.length <= LONG_MESSAGE_THRESHOLD) return false

    let characters = 0
    for (const character of text) {
        characters++
        if (characters > LONG_MESSAGE_THRESHOLD) return true
    }
    return false
}
