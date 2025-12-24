declare module 'bun:bundle' {
    interface Registry {
        features:
            | 'HAPI_TARGET_DARWIN_ARM64'
            | 'HAPI_TARGET_DARWIN_X64'
            | 'HAPI_TARGET_LINUX_ARM64'
            | 'HAPI_TARGET_LINUX_X64'
            | 'HAPI_TARGET_WIN32_X64';
    }

    export function feature(name: Registry['features']): boolean;
}
