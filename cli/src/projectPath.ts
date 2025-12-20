import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { configuration } from '@/configuration';
import packageJson from '../package.json';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bunRuntime = (globalThis as typeof globalThis & { Bun?: { isCompiled?: boolean } }).Bun;
const isCompiled = Boolean(bunRuntime?.isCompiled);

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
