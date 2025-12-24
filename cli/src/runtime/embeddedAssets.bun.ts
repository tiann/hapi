import { feature } from 'bun:bundle';

import difftasticArchiveLicense from '../../tools/archives/difftastic-LICENSE' assert { type: 'file' };
import ripgrepArchiveLicense from '../../tools/archives/ripgrep-LICENSE' assert { type: 'file' };
import difftasticLicense from '../../tools/licenses/difftastic-LICENSE' assert { type: 'file' };
import ripgrepLicense from '../../tools/licenses/ripgrep-LICENSE' assert { type: 'file' };

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
    asset('tools/licenses/ripgrep-LICENSE', ripgrepLicense)
];

async function selectEmbeddedAssets(): Promise<EmbeddedAsset[]> {
    if (feature('HAPI_TARGET_DARWIN_ARM64')) {
        const [{ default: difftasticArm64Darwin }, { default: ripgrepArm64Darwin }] = await Promise.all([
            import('../../tools/archives/difftastic-arm64-darwin.tar.gz', { assert: { type: 'file' } }),
            import('../../tools/archives/ripgrep-arm64-darwin.tar.gz', { assert: { type: 'file' } })
        ]);
        return [
            ...COMMON_ASSETS,
            asset('tools/archives/difftastic-arm64-darwin.tar.gz', difftasticArm64Darwin),
            asset('tools/archives/ripgrep-arm64-darwin.tar.gz', ripgrepArm64Darwin)
        ];
    }

    if (feature('HAPI_TARGET_DARWIN_X64')) {
        const [{ default: difftasticX64Darwin }, { default: ripgrepX64Darwin }] = await Promise.all([
            import('../../tools/archives/difftastic-x64-darwin.tar.gz', { assert: { type: 'file' } }),
            import('../../tools/archives/ripgrep-x64-darwin.tar.gz', { assert: { type: 'file' } })
        ]);
        return [
            ...COMMON_ASSETS,
            asset('tools/archives/difftastic-x64-darwin.tar.gz', difftasticX64Darwin),
            asset('tools/archives/ripgrep-x64-darwin.tar.gz', ripgrepX64Darwin)
        ];
    }

    if (feature('HAPI_TARGET_LINUX_ARM64')) {
        const [{ default: difftasticArm64Linux }, { default: ripgrepArm64Linux }] = await Promise.all([
            import('../../tools/archives/difftastic-arm64-linux.tar.gz', { assert: { type: 'file' } }),
            import('../../tools/archives/ripgrep-arm64-linux.tar.gz', { assert: { type: 'file' } })
        ]);
        return [
            ...COMMON_ASSETS,
            asset('tools/archives/difftastic-arm64-linux.tar.gz', difftasticArm64Linux),
            asset('tools/archives/ripgrep-arm64-linux.tar.gz', ripgrepArm64Linux)
        ];
    }

    if (feature('HAPI_TARGET_LINUX_X64')) {
        const [{ default: difftasticX64Linux }, { default: ripgrepX64Linux }] = await Promise.all([
            import('../../tools/archives/difftastic-x64-linux.tar.gz', { assert: { type: 'file' } }),
            import('../../tools/archives/ripgrep-x64-linux.tar.gz', { assert: { type: 'file' } })
        ]);
        return [
            ...COMMON_ASSETS,
            asset('tools/archives/difftastic-x64-linux.tar.gz', difftasticX64Linux),
            asset('tools/archives/ripgrep-x64-linux.tar.gz', ripgrepX64Linux)
        ];
    }

    if (feature('HAPI_TARGET_WIN32_X64')) {
        const [{ default: difftasticX64Win32 }, { default: ripgrepX64Win32 }] = await Promise.all([
            import('../../tools/archives/difftastic-x64-win32.tar.gz', { assert: { type: 'file' } }),
            import('../../tools/archives/ripgrep-x64-win32.tar.gz', { assert: { type: 'file' } })
        ]);
        return [
            ...COMMON_ASSETS,
            asset('tools/archives/difftastic-x64-win32.tar.gz', difftasticX64Win32),
            asset('tools/archives/ripgrep-x64-win32.tar.gz', ripgrepX64Win32)
        ];
    }

    throw new Error('No build target feature flag set. Build with --feature=HAPI_TARGET_*.');
}

export async function loadEmbeddedAssets(): Promise<EmbeddedAsset[]> {
    return selectEmbeddedAssets();
}
