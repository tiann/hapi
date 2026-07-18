export type ClaudeObservedProcessExit = {
  code: number | null;
  signal: string | null;
};

export class ClaudeProcessExitError extends Error {
  readonly childExit: ClaudeObservedProcessExit;

  constructor(childExit: ClaudeObservedProcessExit) {
    super('Claude Code process exited');
    if (childExit.code === null && childExit.signal === null) {
      throw new Error('ClaudeProcessExitError requires an exit code or signal');
    }
    this.name = 'ClaudeProcessExitError';
    this.childExit = childExit;
  }
}

export function formatClaudeRemoteFailure(error: unknown): string {
  if (error instanceof ClaudeProcessExitError) {
    return `Process exited unexpectedly (code=${error.childExit.code ?? 'null'}, signal=${error.childExit.signal ?? 'null'})`;
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return 'Aborted by user';
  }

  const detail = error instanceof Error ? error.message : String(error);
  return `Claude request failed: ${detail}`;
}
