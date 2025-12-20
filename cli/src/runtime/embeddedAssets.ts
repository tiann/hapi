import { fileURLToPath } from 'node:url';

export interface EmbeddedAsset {
    relativePath: string;
    sourcePath: string;
}

export const EMBEDDED_ASSETS: EmbeddedAsset[] = [
    {
        relativePath: 'scripts/claude_local_launcher.cjs',
        sourcePath: fileURLToPath(new URL('../../scripts/claude_local_launcher.cjs', import.meta.url))
    },
    {
        relativePath: 'scripts/claude_remote_launcher.cjs',
        sourcePath: fileURLToPath(new URL('../../scripts/claude_remote_launcher.cjs', import.meta.url))
    },
    {
        relativePath: 'scripts/claude_version_utils.cjs',
        sourcePath: fileURLToPath(new URL('../../scripts/claude_version_utils.cjs', import.meta.url))
    },
    {
        relativePath: 'scripts/ripgrep_launcher.cjs',
        sourcePath: fileURLToPath(new URL('../../scripts/ripgrep_launcher.cjs', import.meta.url))
    },
    {
        relativePath: 'scripts/unpack-tools.cjs',
        sourcePath: fileURLToPath(new URL('../../scripts/unpack-tools.cjs', import.meta.url))
    },
    {
        relativePath: 'bin/happy.mjs',
        sourcePath: fileURLToPath(new URL('../../bin/happy.mjs', import.meta.url))
    },
    {
        relativePath: 'bin/happy-mcp.mjs',
        sourcePath: fileURLToPath(new URL('../../bin/happy-mcp.mjs', import.meta.url))
    },
    {
        relativePath: 'tools/archives/difftastic-LICENSE',
        sourcePath: fileURLToPath(new URL('../../tools/archives/difftastic-LICENSE', import.meta.url))
    },
    {
        relativePath: 'tools/archives/ripgrep-LICENSE',
        sourcePath: fileURLToPath(new URL('../../tools/archives/ripgrep-LICENSE', import.meta.url))
    },
    {
        relativePath: 'tools/archives/difftastic-arm64-darwin.tar.gz',
        sourcePath: fileURLToPath(new URL('../../tools/archives/difftastic-arm64-darwin.tar.gz', import.meta.url))
    },
    {
        relativePath: 'tools/archives/difftastic-arm64-linux.tar.gz',
        sourcePath: fileURLToPath(new URL('../../tools/archives/difftastic-arm64-linux.tar.gz', import.meta.url))
    },
    {
        relativePath: 'tools/archives/difftastic-x64-darwin.tar.gz',
        sourcePath: fileURLToPath(new URL('../../tools/archives/difftastic-x64-darwin.tar.gz', import.meta.url))
    },
    {
        relativePath: 'tools/archives/difftastic-x64-linux.tar.gz',
        sourcePath: fileURLToPath(new URL('../../tools/archives/difftastic-x64-linux.tar.gz', import.meta.url))
    },
    {
        relativePath: 'tools/archives/difftastic-x64-win32.tar.gz',
        sourcePath: fileURLToPath(new URL('../../tools/archives/difftastic-x64-win32.tar.gz', import.meta.url))
    },
    {
        relativePath: 'tools/archives/ripgrep-arm64-darwin.tar.gz',
        sourcePath: fileURLToPath(new URL('../../tools/archives/ripgrep-arm64-darwin.tar.gz', import.meta.url))
    },
    {
        relativePath: 'tools/archives/ripgrep-arm64-linux.tar.gz',
        sourcePath: fileURLToPath(new URL('../../tools/archives/ripgrep-arm64-linux.tar.gz', import.meta.url))
    },
    {
        relativePath: 'tools/archives/ripgrep-x64-darwin.tar.gz',
        sourcePath: fileURLToPath(new URL('../../tools/archives/ripgrep-x64-darwin.tar.gz', import.meta.url))
    },
    {
        relativePath: 'tools/archives/ripgrep-x64-linux.tar.gz',
        sourcePath: fileURLToPath(new URL('../../tools/archives/ripgrep-x64-linux.tar.gz', import.meta.url))
    },
    {
        relativePath: 'tools/archives/ripgrep-x64-win32.tar.gz',
        sourcePath: fileURLToPath(new URL('../../tools/archives/ripgrep-x64-win32.tar.gz', import.meta.url))
    },
    {
        relativePath: 'tools/licenses/difftastic-LICENSE',
        sourcePath: fileURLToPath(new URL('../../tools/licenses/difftastic-LICENSE', import.meta.url))
    },
    {
        relativePath: 'tools/licenses/ripgrep-LICENSE',
        sourcePath: fileURLToPath(new URL('../../tools/licenses/ripgrep-LICENSE', import.meta.url))
    }
];
