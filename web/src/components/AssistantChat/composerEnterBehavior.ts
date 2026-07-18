// Decide whether an Enter keypress should insert a newline rather than send.
// Touch devices (iOS soft keyboards in particular) cannot emit Shift+Enter,
// so on touch we treat bare Enter as newline and rely on the send button.
export function shouldEnterInsertNewline(opts: { shiftKey: boolean; isTouch: boolean }): boolean {
    return opts.shiftKey || opts.isTouch
}
