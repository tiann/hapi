import type { EmbeddedWebAsset } from './embeddedAssets.generated';

let embeddedAssetMap: Map<string, EmbeddedWebAsset> | null = null;

export type { EmbeddedWebAsset };

export async function loadEmbeddedAssetMap(): Promise<Map<string, EmbeddedWebAsset>> {
    if (embeddedAssetMap) {
        return embeddedAssetMap;
    }

    const { embeddedAssets } = await import('./embeddedAssets.generated');
    embeddedAssetMap = new Map(embeddedAssets.map((asset) => [asset.path, asset]));
    return embeddedAssetMap;
}
