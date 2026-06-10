/**
 * JSONL line parser — shared by all stdio-based agent transports.
 *
 * Buffers raw stdout chunks, splits on newlines, and emits complete lines.
 * Each transport provides its own `handleLine` to parse the JSON and
 * dispatch domain-specific events.
 */
export abstract class JsonLineParser {
    private buffer = '';

    /** Feed a raw stdout chunk into the parser. */
    feed(chunk: string): void {
        this.buffer += chunk;
        let newlineIndex = this.buffer.indexOf('\n');

        while (newlineIndex >= 0) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (line.length > 0) {
                this.handleLine(line);
            }

            newlineIndex = this.buffer.indexOf('\n');
        }
    }

    /** Reset internal buffer (e.g. on process restart). */
    reset(): void {
        this.buffer = '';
    }

    /** Override to parse a complete JSON line and dispatch events. */
    protected abstract handleLine(line: string): void;
}
