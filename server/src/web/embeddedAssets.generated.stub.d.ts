// Stub types for embeddedAssets.generated.ts when the manifest is not generated.
declare module './embeddedAssets.generated' {
    export interface EmbeddedWebAsset {
        path: string;
        sourcePath: string;
        mimeType: string;
    }

    export const embeddedAssets: EmbeddedWebAsset[];
}
