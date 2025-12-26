/** Bun embeds compiled code in a virtual filesystem: /$bunfs/ (Linux/macOS) or /~BUN/ (Windows) */
export function isBunCompiled(): boolean {
    const bunMain = globalThis.Bun?.main ?? '';
    return bunMain.includes('$bunfs') || bunMain.includes('/~BUN/');
}
