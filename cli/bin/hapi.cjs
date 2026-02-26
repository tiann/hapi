#!/usr/bin/env node

const { execFileSync } = require('child_process');
const path = require('path');

const platform = process.platform;
const arch = process.arch;
const pkgName = `@twsxtd/hapi-${platform}-${arch}`;

function getBinaryPath() {
    try {
        // Try to find the platform-specific package
        const pkgPath = require.resolve(`${pkgName}/package.json`);
        const binName = platform === 'win32' ? 'hapi.exe' : 'hapi';
        return path.join(path.dirname(pkgPath), 'bin', binName);
    } catch (e) {
        return null;
    }
}

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

function formatCommand(bin, args) {
    return [bin, ...args].map((arg) => JSON.stringify(arg)).join(' ');
}

try {
    execFileSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
} catch (e) {
    const args = process.argv.slice(2);
    const command = formatCommand(binPath, args);
    const status = typeof e.status === 'number' ? e.status : null;
    const signal = typeof e.signal === 'string' ? e.signal : null;

    console.error(`Failed to execute: ${command}`);
    if (signal) {
        console.error(`Binary terminated by signal ${signal}.`);
    }
    if (status !== null) {
        console.error(`Binary exited with status ${status}.`);
    }
    if (e.message) {
        console.error(e.message);
    }

    if (status !== null) {
        process.exit(status);
    }
    if (signal) {
        process.kill(process.pid, signal);
    }
    process.exit(1);
}
