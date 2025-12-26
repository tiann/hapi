/** Bun embeds compiled code in a virtual filesystem: /$bunfs/ (Linux/macOS) or /~BUN/ (Windows) */
export function isBunCompiled(): boolean {
    return Bun.main.includes('$bunfs') || Bun.main.includes('/~BUN/');
}
