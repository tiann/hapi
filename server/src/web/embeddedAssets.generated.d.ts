// Stub types for embeddedAssets.generated.ts when the manifest is not generated.

export interface EmbeddedWebAsset {
    path: string;
    sourcePath: string;
    mimeType: string;
}

export const embeddedAssets: EmbeddedWebAsset[];

declare module '*web/dist/*' {
    const sourcePath: string;
    export default sourcePath;
}
