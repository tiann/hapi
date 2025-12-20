import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { configuration } from '@/configuration';
import packageJson from '../package.json';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bunRuntime = (globalThis as typeof globalThis & { Bun?: { isCompiled?: boolean } }).Bun;
const argv1 = process.argv[1] ?? '';
const bunFsMarker = argv1.includes('$bunfs');
const isCompiled = Boolean(bunRuntime?.isCompiled) || bunFsMarker;

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
