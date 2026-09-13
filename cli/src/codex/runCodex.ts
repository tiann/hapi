// Codex has no local/remote handoff. Both surfaces share one isolated app-server;
// the owning terminal stops it on exit, while additional terminals only detach.
export { runSharedCodex as runCodex } from './shared/frontend';
export { emitReadyIfIdle } from './utils/emitReadyIfIdle';
