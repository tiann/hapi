import difftasticArchiveLicense from '../../tools/archives/difftastic-LICENSE' assert { type: 'file' };
import ripgrepArchiveLicense from '../../tools/archives/ripgrep-LICENSE' assert { type: 'file' };
import difftasticLicense from '../../tools/licenses/difftastic-LICENSE' assert { type: 'file' };
import ripgrepLicense from '../../tools/licenses/ripgrep-LICENSE' assert { type: 'file' };
import tunwgLicense from '../../../hub/tools/tunwg/LICENSE' assert { type: 'file' };

// Platform-specific imports - all imported statically, only used based on runtime detection
import difftasticArm64Darwin from '../../tools/archives/difftastic-arm64-darwin.tar.gz' assert { type: 'file' };
import ripgrepArm64Darwin from '../../tools/archives/ripgrep-arm64-darwin.tar.gz' assert { type: 'file' };
import tunwgArm64Darwin from '../../../hub/tools/tunwg/tunwg-arm64-darwin' assert { type: 'file' };

import difftasticX64Darwin from '../../tools/archives/difftastic-x64-darwin.tar.gz' assert { type: 'file' };
import ripgrepX64Darwin from '../../tools/archives/ripgrep-x64-darwin.tar.gz' assert { type: 'file' };
import tunwgX64Darwin from '../../../hub/tools/tunwg/tunwg-x64-darwin' assert { type: 'file' };

import difftasticArm64Linux from '../../tools/archives/difftastic-arm64-linux.tar.gz' assert { type: 'file' };
import ripgrepArm64Linux from '../../tools/archives/ripgrep-arm64-linux.tar.gz' assert { type: 'file' };
import tunwgArm64Linux from '../../../hub/tools/tunwg/tunwg-arm64-linux' assert { type: 'file' };

import difftasticX64Linux from '../../tools/archives/difftastic-x64-linux.tar.gz' assert { type: 'file' };
import ripgrepX64Linux from '../../tools/archives/ripgrep-x64-linux.tar.gz' assert { type: 'file' };
import tunwgX64Linux from '../../../hub/tools/tunwg/tunwg-x64-linux' assert { type: 'file' };

import difftasticX64Win32 from '../../tools/archives/difftastic-x64-win32.tar.gz' assert { type: 'file' };
import ripgrepX64Win32 from '../../tools/archives/ripgrep-x64-win32.tar.gz' assert { type: 'file' };
import tunwgX64Win32 from '../../../hub/tools/tunwg/tunwg-x64-win32.exe' assert { type: 'file' };

export interface EmbeddedAsset {
    relativePath: string;
    sourcePath: string;
}

function asset(relativePath: string, sourcePath: string): EmbeddedAsset {
    return {
        relativePath,
        sourcePath
    };
}

const COMMON_ASSETS: EmbeddedAsset[] = [
    asset('tools/archives/difftastic-LICENSE', difftasticArchiveLicense),
    asset('tools/archives/ripgrep-LICENSE', ripgrepArchiveLicense),
    asset('tools/licenses/difftastic-LICENSE', difftasticLicense),
    asset('tools/licenses/ripgrep-LICENSE', ripgrepLicense),
    asset('tools/tunwg/LICENSE', tunwgLicense)
];

function selectEmbeddedAssets(): EmbeddedAsset[] {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'darwin' && arch === 'arm64') {
        return [
            ...COMMON_ASSETS,
            asset('tools/archives/difftastic-arm64-darwin.tar.gz', difftasticArm64Darwin),
            asset('tools/archives/ripgrep-arm64-darwin.tar.gz', ripgrepArm64Darwin),
            asset('tools/tunwg/tunwg', tunwgArm64Darwin)
        ];
    }

    if (platform === 'darwin' && arch === 'x64') {
        return [
            ...COMMON_ASSETS,
            asset('tools/archives/difftastic-x64-darwin.tar.gz', difftasticX64Darwin),
            asset('tools/archives/ripgrep-x64-darwin.tar.gz', ripgrepX64Darwin),
            asset('tools/tunwg/tunwg', tunwgX64Darwin)
        ];
    }

    if (platform === 'linux' && arch === 'arm64') {
        return [
            ...COMMON_ASSETS,
            asset('tools/archives/difftastic-arm64-linux.tar.gz', difftasticArm64Linux),
            asset('tools/archives/ripgrep-arm64-linux.tar.gz', ripgrepArm64Linux),
            asset('tools/tunwg/tunwg', tunwgArm64Linux)
        ];
    }

    if (platform === 'linux' && arch === 'x64') {
        return [
            ...COMMON_ASSETS,
            asset('tools/archives/difftastic-x64-linux.tar.gz', difftasticX64Linux),
            asset('tools/archives/ripgrep-x64-linux.tar.gz', ripgrepX64Linux),
            asset('tools/tunwg/tunwg', tunwgX64Linux)
        ];
    }

    if (platform === 'win32' && arch === 'x64') {
        return [
            ...COMMON_ASSETS,
            asset('tools/archives/difftastic-x64-win32.tar.gz', difftasticX64Win32),
            asset('tools/archives/ripgrep-x64-win32.tar.gz', ripgrepX64Win32),
            asset('tools/tunwg/tunwg.exe', tunwgX64Win32)
        ];
    }

    throw new Error(`Unsupported platform: ${arch}-${platform}`);
}

export async function loadEmbeddedAssets(): Promise<EmbeddedAsset[]> {
    return selectEmbeddedAssets();
}
