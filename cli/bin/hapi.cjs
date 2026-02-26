#!/usr/bin/env node

const { execFileSync } = require('child_process');
const path = require('path');

const platform = process.platform;
const arch = process.arch;

function getBinaryPath(platformName = platform, archName = arch) {
    const pkgName = `@twsxtd/hapi-${platformName}-${archName}`;

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

function main() {
    const binPath = getBinaryPath();

    if (!binPath) {
        console.error(`Unsupported platform: ${platform}-${arch}`);
        console.error('');
        console.error('Supported platforms:');
        console.error('  - darwin-arm64 (macOS Apple Silicon)');
        console.error('  - darwin-x64 (macOS Intel)');
        console.error('  - linux-arm64');
        console.error('  - linux-x64');
        console.error('  - win32-x64');
        console.error('');
        console.error('You can download the binary manually from:');
        console.error('  https://github.com/tiann/hapi/releases');
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
    getBinaryPath,
    normalizeExecError,
    reportExecutionFailure,
};
