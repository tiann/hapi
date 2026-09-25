const STORAGE_KEY = 'hapi-auto-bridge-transient-model-errors';

export function readAutoBridgeTransientModelErrors(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function writeAutoBridgeTransientModelErrors(enabled: boolean): void {
    try {
        if (enabled) {
            localStorage.setItem(STORAGE_KEY, 'true');
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    } catch {
        // ignore quota / privacy mode failures
    }
}
