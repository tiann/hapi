// Type declaration for embeddedAssets.compiled.js
// This file is generated at build time by scripts/generate-compiled-assets.ts

export interface EmbeddedAsset {
    relativePath: string;
    sourcePath: string;
}

export function loadEmbeddedAssets(): Promise<EmbeddedAsset[]>;
