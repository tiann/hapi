import type { CursorModelSummary } from '@hapi/protocol/apiTypes';

export type CursorModelsSnapshot = {
    availableModels: CursorModelSummary[];
    currentModelId: string | null;
};

let snapshot: CursorModelsSnapshot | null = null;

export function setCursorAcpModelsSnapshot(value: CursorModelsSnapshot | null): void {
    snapshot = value;
}

export function getCursorAcpModelsSnapshot(): CursorModelsSnapshot | null {
    return snapshot;
}
