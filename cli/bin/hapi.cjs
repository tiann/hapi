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

try {
    execFileSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
} catch (e) {
    // If the binary execution fails, exit with the same code
    if (e.status !== undefined) {
        process.exit(e.status);
    }
    // For other errors (e.g., binary not found), print and exit
    console.error(`Failed to execute ${binPath}:`, e.message);
    process.exit(1);
}
