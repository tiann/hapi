import type { PermissionModeOf, Flavors } from '@hapi/protocol/types';

export type PermissionMode = PermissionModeOf<typeof Flavors.kimi>;

export interface KimiMode {
    permissionMode: PermissionMode;
    model?: string;
    effort?: string | null;
}
