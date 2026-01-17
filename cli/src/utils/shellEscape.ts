/**
 * Strip newlines when passing args through Windows cmd.exe.
 * cmd.exe treats CR/LF as command separators and truncates multiline args.
 */
export function stripNewlinesForWindowsShellArg(value: string): string {
    if (process.platform !== 'win32') {
        return value;
    }
    return value.replace(/\r?\n/g, ' ');
}
