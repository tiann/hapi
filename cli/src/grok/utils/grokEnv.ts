const GROK_ENV_KEYS = new Set([
    'PATH',
    'HOME',
    'USER',
    'USERNAME',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'TZ',
    'LANG',
    'LANGUAGE',
    'TERM',
    'COLORTERM',
    'NO_COLOR',
    'FORCE_COLOR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_RUNTIME_DIR',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'HOMEDRIVE',
    'HOMEPATH'
]);

const GROK_ENV_PREFIXES = ['LC_', 'GROK_', 'XAI_'];

export function buildGrokEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        const normalized = key.toUpperCase();
        if (
            GROK_ENV_KEYS.has(normalized)
            || GROK_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
        ) {
            output[key] = value;
        }
    }
    return output;
}
