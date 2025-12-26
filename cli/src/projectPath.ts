import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { configuration } from '@/configuration';
import packageJson from '../package.json';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Bun embeds compiled code in a virtual filesystem: /$bunfs/ (Linux/macOS) or /~BUN/ (Windows) */
const isCompiled = Bun.main.includes('$bunfs') || Bun.main.includes('/~BUN/');

export function projectPath(): string {
    return resolve(__dirname, '..');
}

export function runtimePath(): string {
    if (!isCompiled) {
        return projectPath();
    }

    return join(configuration.happyHomeDir, 'runtime', packageJson.version);
}

export function isBunCompiled(): boolean {
    return isCompiled;
}
