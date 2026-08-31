#!/usr/bin/env node

const { execFileSync } = require('child_process');
const path = require('path');

const platform = process.platform;
const arch = process.arch;
const NPM_SCOPE = '@youngfine';
const MAIN_PACKAGE = `${NPM_SCOPE}/hapi`;
const RELEASE_URL = 'https://github.com/Conanxy/hapi/releases';
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';
const SUPPORTED_PLATFORMS = [
    {
        key: 'darwin-arm64',
        label: 'darwin-arm64 (macOS Apple Silicon)',
    },
    {
        key: 'darwin-x64',
        label: 'darwin-x64 (macOS Intel)',
    },
    {
        key: 'linux-arm64',
        label: 'linux-arm64',
    },
    {
        key: 'linux-x64',
        label: 'linux-x64',
    },
    {
        key: 'win32-x64',
        label: 'win32-x64',
    },
];

function getPlatformKey(platformName = platform, archName = arch) {
    return `${platformName}-${archName}`;
}

function isSupportedPlatform(platformName = platform, archName = arch) {
    return SUPPORTED_PLATFORMS.some((item) => item.key === getPlatformKey(platformName, archName));
}

function getBinaryPath(platformName = platform, archName = arch) {
    const pkgName = `${NPM_SCOPE}/hapi-${platformName}-${archName}`;

    try {
        // Try to find the platform-specific package
        const pkgPath = require.resolve(`${pkgName}/package.json`);
        const binName = platformName === 'win32' ? 'hapi.exe' : 'hapi';
        return path.join(path.dirname(pkgPath), 'bin', binName);
    } catch (e) {
        return null;
    }
}

function formatCommand(binPath, args) {
    return [binPath, ...args].map((arg) => JSON.stringify(String(arg))).join(' ');
}

function normalizeExecError(error) {
    return {
        status: typeof error?.status === 'number' ? error.status : null,
        signal: typeof error?.signal === 'string' ? error.signal : null,
        message: error?.message ? String(error.message) : null,
    };
}

function reportExecutionFailure(error, binPath, args, log = console.error) {
    const { status, signal, message } = normalizeExecError(error);

    log(`Failed to execute: ${formatCommand(binPath, args)}`);

    if (signal) {
        log(`Binary terminated by signal ${signal}.`);
    }

    if (status !== null) {
        log(`Binary exited with status ${status}.`);
    }

    if (message) {
        log(message);
    }

    return { status, signal };
}

function reportUnsupportedPlatform(platformName = platform, archName = arch, log = console.error) {
    log(`Unsupported platform: ${platformName}-${archName}`);
    log('');
    log('Supported platforms:');
    for (const item of SUPPORTED_PLATFORMS) {
        log(`  - ${item.label}`);
    }
    log('');
    log('You can download the binary manually from:');
    log(`  ${RELEASE_URL}`);
}

function reportMissingPlatformPackage(platformName = platform, archName = arch, log = console.error) {
    const platformPackage = `${NPM_SCOPE}/hapi-${platformName}-${archName}`;
    log(`Missing platform package: ${platformPackage}`);
    log('');
    log(`Detected platform ${platformName}-${archName} is supported, but the platform binary package was not installed.`);
    log('This may happen when using a registry mirror that has not synced all optionalDependencies.');
    log('');
    log('Try reinstalling with the official npm registry:');
    log(`  npm install -g ${MAIN_PACKAGE} --registry=${OFFICIAL_NPM_REGISTRY}`);
    log('');
    log('Or download the binary manually from:');
    log(`  ${RELEASE_URL}`);
}

function main() {
    if (!isSupportedPlatform()) {
        reportUnsupportedPlatform();
        process.exit(1);
    }

    const binPath = getBinaryPath();
    if (!binPath) {
        reportMissingPlatformPackage();
        process.exit(1);
    }

    const args = process.argv.slice(2);

    try {
        execFileSync(binPath, args, { stdio: 'inherit' });
    } catch (error) {
        const { status, signal } = reportExecutionFailure(error, binPath, args);

        if (status !== null) {
            process.exit(status);
        }

        if (signal) {
            try {
                process.kill(process.pid, signal);
            } catch {
                // ignore unsupported/invalid signal names on this platform
            }
        }

        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    formatCommand,
    getPlatformKey,
    getBinaryPath,
    isSupportedPlatform,
    normalizeExecError,
    reportExecutionFailure,
    reportMissingPlatformPackage,
    reportUnsupportedPlatform,
};
