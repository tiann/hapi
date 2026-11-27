import type { CursorTodoSnapshot } from '@hapi/protocol/schemas';
import type { ApiSessionClient } from '@/api/apiSession';

// Backends can be replaced before the previous agent-state write is acknowledged.
export const cursorTodosBySession = new WeakMap<ApiSessionClient, { revision?: string; items: CursorTodoSnapshot }>();
