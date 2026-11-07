import { closeSync, fsyncSync, openSync } from 'node:fs'

/** Win32 FlushFileBuffers requires a writable regular-file handle. */
export function fsyncFile(path: string): void {
    const fd = openSync(path, process.platform === 'win32' ? 'r+' : 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
}
