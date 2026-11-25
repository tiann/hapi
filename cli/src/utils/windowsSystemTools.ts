import { win32 } from 'node:path'

export type WindowsSystemTool = 'taskkill' | 'tasklist' | 'powershell' | 'wmic' | 'where'

const TOOL_PATHS: Record<WindowsSystemTool, string> = {
    taskkill: 'System32\\taskkill.exe',
    tasklist: 'System32\\tasklist.exe',
    powershell: 'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    wmic: 'System32\\wbem\\WMIC.exe',
    where: 'System32\\where.exe',
}

/** Absolute path of a Windows system tool; a bare name would also match a same-named file in the working directory. */
export function windowsSystemTool(tool: WindowsSystemTool, env: Record<string, string | undefined> = process.env): string {
    const root = [env.SystemRoot, env.SYSTEMROOT, env.windir].find((dir) => dir && /^[A-Za-z]:[\\/]/.test(dir))
    return win32.join(root ?? 'C:\\Windows', TOOL_PATHS[tool])
}
