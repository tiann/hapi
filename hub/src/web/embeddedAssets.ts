import { feature } from 'bun:bundle';
import type { EmbeddedWebAsset } from './embeddedAssets.generated';

let embeddedAssetMap: Map<string, EmbeddedWebAsset> | null = null;

export type { EmbeddedWebAsset };

export async function loadEmbeddedAssetMap(): Promise<Map<string, EmbeddedWebAsset>> {
    if (embeddedAssetMap) {
        return embeddedAssetMap;
    }

    // Fleet runner artifacts compile with --feature=HAPI_RUNNER_ONLY so bun
    // dead-code-eliminates the generated web-asset import (no live-tree stub).
    if (feature('HAPI_RUNNER_ONLY')) {
        embeddedAssetMap = new Map();
        return embeddedAssetMap;
    }

    const { embeddedAssets } = await import('./embeddedAssets.generated');
    embeddedAssetMap = new Map(embeddedAssets.map((asset) => [asset.path, asset]));
    return embeddedAssetMap;
}
