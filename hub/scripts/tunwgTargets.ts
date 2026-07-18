export const TUNWG_VERSION = 'v26.01.13+359bfa2';

export type TunwgRelease = Readonly<{
    url: string;
    sha256: string;
}>;

const ENCODED_TUNWG_VERSION = encodeURIComponent(TUNWG_VERSION);
const RELEASE_BASE_URL = `https://github.com/tiann/tunwg/releases/download/${ENCODED_TUNWG_VERSION}`;

const TUNWG_RELEASES: Readonly<Record<string, TunwgRelease>> = {
    'x64-linux': {
        url: `${RELEASE_BASE_URL}/tunwg`,
        sha256: 'a61c96c0b11e28cfc1904ad04779670e90133bae4e9bd17b979dad7de8319238',
    },
    'arm64-linux': {
        url: `${RELEASE_BASE_URL}/tunwg-arm64`,
        sha256: '19be6977f84acb5a4ceac96deb829f967a188b7975fa67f2d174acf745d70891',
    },
    'x64-darwin': {
        url: `${RELEASE_BASE_URL}/tunwg-darwin`,
        sha256: 'e226d325b4fadf43ee7138168b84da239e35c8ed82d4a87f0745f0769ae6b222',
    },
    'arm64-darwin': {
        url: `${RELEASE_BASE_URL}/tunwg-darwin-arm64`,
        sha256: '70c90b59e1aded850cf3b77d5eb6145302a17a91e7267e2d12a5a675fa1784cd',
    },
    'x64-win32': {
        url: `${RELEASE_BASE_URL}/tunwg.exe`,
        sha256: 'dd52d035139e27402eadff761dbd1dda70c161551ae2eafcbc3ca0afa77b6f21',
    },
};

export const TUNWG_LICENSE: TunwgRelease = {
    url: `https://raw.githubusercontent.com/tiann/tunwg/${ENCODED_TUNWG_VERSION}/LICENSE`,
    sha256: 'd8ac11fb1304443975a04293266bc30227d0dbf01a44f9d51d9ece096aadbe36',
};

export function selectTunwgReleases(
    args: string[],
    platform: NodeJS.Platform = process.platform,
    arch: NodeJS.Architecture = process.arch,
): Array<[string, TunwgRelease]> {
    if (args.includes('--host')) {
        const platformSuffix = platform === 'win32' ? 'win32' : platform;
        const key = `${arch}-${platformSuffix}`;
        const release = TUNWG_RELEASES[key];
        if (!release) {
            throw new Error(`Unsupported host target: ${platform}-${arch}`);
        }
        return [[key, release]];
    }
    return Object.entries(TUNWG_RELEASES);
}
