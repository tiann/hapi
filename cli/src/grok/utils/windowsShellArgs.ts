const WINDOWS_SHELL_ARG_PATTERN = /[&|<>^()%!"\r\n]/u

/** Reject dynamic values before passing them to a Windows `shell: true` spawn. */
export function assertSafeWindowsShellArg(value: string, label: string): void {
    if (process.platform === 'win32' && WINDOWS_SHELL_ARG_PATTERN.test(value)) {
        throw new Error(`Invalid ${label}: contains Windows shell metacharacters`)
    }
}
