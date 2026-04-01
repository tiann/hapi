import { isAbsolute } from 'node:path';

export function getInvokedCwd(): string {
    const invokedCwd = process.env.HAPI_INVOKED_CWD?.trim();
    if (invokedCwd && isAbsolute(invokedCwd)) {
        return invokedCwd;
    }
    return process.cwd();
}
