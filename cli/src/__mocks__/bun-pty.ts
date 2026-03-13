// Mock for bun-pty in test environment
// bun-pty depends on bun:ffi which is not available in Node.js/vitest

export interface IDisposable {
    dispose(): void
}

export interface IPty {
    pid: number
    cols: number
    rows: number
    process: string
    handleFlowControl: boolean
    onData(listener: (data: string) => void): IDisposable
    onExit(listener: (exitCode: number, signal?: number) => void): IDisposable
    write(data: string): void
    resize(cols: number, rows: number): void
    clear(): void
    kill(signal?: string): void
    pause(): void
    resume(): void
}

// Mock spawn function that returns null (simulating unavailable runtime)
export const spawn: null = null

export default {
    spawn
}
