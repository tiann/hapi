const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g
const ANSI_OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export function stripAnsiAndControls(text: string): string {
    const normalized = text.replace(/\r\n?/g, '\n')
    const withoutOsc = normalized.replace(ANSI_OSC_REGEX, '')
    const withoutAnsi = withoutOsc.replace(ANSI_REGEX, '')
    return withoutAnsi.replace(CONTROL_CHARS_REGEX, '')
}
