import { describe, expect, it } from 'vitest';
import { GenerationClock, generationTimeMs } from './generationClock';
import type { AgentMessage } from './types';

/** Deterministic clock: milliseconds since a fixed origin, advanced by hand. */
function steppedClock(start = 0) {
    let now = start;
    return {
        now: () => now,
        advance: (ms: number) => { now += ms; }
    };
}

const chunk = (text = 'chunk'): AgentMessage => ({ type: 'text', text });
const thought = (): AgentMessage => ({ type: 'reasoning', text: 'thinking', id: 'r1' });
const toolCall = (id: string, status: 'pending' | 'in_progress' | 'completed' | 'failed' = 'in_progress'): AgentMessage =>
    ({ type: 'tool_call', id, name: 'shell', input: {}, status });
const toolResult = (id: string): AgentMessage =>
    ({ type: 'tool_result', id, output: 'ok', status: 'completed' });

describe('generationTimeMs', () => {
    it('subtracts merged, round-clipped idle windows from the round', () => {
        // A tool run and, separately, a wait for the user.
        expect(generationTimeMs(0, 10_000, [{ start: 1_000, end: 4_000 }, { start: 6_000, end: 7_000 }])).toBe(6_000);
        // Windows from two requests of one turn, in any order.
        expect(generationTimeMs(0, 20_000, [{ start: 12_000, end: 15_000 }, { start: 2_000, end: 8_000 }])).toBe(11_000);
        // An approval wait inside a tool's span counts once.
        expect(generationTimeMs(0, 10_000, [{ start: 1_000, end: 6_000 }, { start: 2_000, end: 3_000 }, { start: 5_000, end: 8_000 }])).toBe(3_000);
        // Cancelled mid-tool: the open window ends with the round; spans
        // outside the round do not count.
        expect(generationTimeMs(1_000, 5_000, [{ start: 0, end: 2_000 }, { start: 3_000, end: null }])).toBe(1_000);
        // No answer, or nothing left but tools.
        expect(generationTimeMs(0, null, [])).toBeNull();
        expect(generationTimeMs(null, 5_000, [])).toBeNull();
        expect(generationTimeMs(0, 5_000, [{ start: 0, end: 5_000 }])).toBe(0);
    });
});

describe('GenerationClock', () => {
    it('counts a round of chunks alone as generation time', () => {
        const time = steppedClock();
        const clock = new GenerationClock(time.now);
        clock.observe(chunk());
        time.advance(200);
        clock.observe(thought());
        time.advance(300);
        expect(clock.generationMs(0, 500)).toBe(500);
    });

    it('excludes tool time between chunks', () => {
        const time = steppedClock();
        const clock = new GenerationClock(time.now);
        clock.observe(chunk());
        time.advance(1_000);
        clock.observe(toolCall('t1'));
        time.advance(3_000);
        clock.observe(toolResult('t1'));
        clock.observe(chunk());
        time.advance(1_000);
        expect(clock.generationMs(0, 5_000)).toBe(2_000);
    });

    it('excludes a wait for the user from generation time', () => {
        const time = steppedClock();
        const clock = new GenerationClock(time.now);
        clock.observe(chunk());
        time.advance(1_000);
        const answered = clock.beginUserWait();
        time.advance(1_500);
        answered();
        time.advance(2_500);
        expect(clock.generationMs(0, 5_000)).toBe(3_500);
    });

    it('returns null when the turn produced no output at all', () => {
        const clock = new GenerationClock(steppedClock().now);
        expect(clock.generationMs(0, 5_000)).toBeNull();
    });

    it('counts a tool-only turn: the model generated the tool call', () => {
        const time = steppedClock();
        const clock = new GenerationClock(time.now);
        time.advance(1_000);
        clock.observe(toolCall('t1'));
        time.advance(1_000);
        clock.observe(toolResult('t1'));
        time.advance(3_000);
        expect(clock.generationMs(0, 5_000)).toBe(4_000);
    });

    it('opens a tool window on the first report and closes it on completion', () => {
        const time = steppedClock();
        const clock = new GenerationClock(time.now);
        clock.observe(chunk());
        time.advance(1_000);
        // Waiting for approval: the agent already stopped generating.
        clock.observe(toolCall('t1', 'pending'));
        time.advance(500);
        clock.observe(toolCall('t1'));
        time.advance(2_500);
        clock.observe(toolCall('t1', 'completed'));
        time.advance(1_000);
        expect(clock.generationMs(0, 5_000)).toBe(2_000);
    });

    it('closes a tool still open at the answer with the round', () => {
        const time = steppedClock();
        const clock = new GenerationClock(time.now);
        clock.observe(chunk());
        time.advance(1_000);
        clock.observe(toolCall('t1'));
        expect(clock.generationMs(0, 5_000)).toBe(1_000);
    });

    it('ignores usage reports and turn boundaries', () => {
        const clock = new GenerationClock(steppedClock().now);
        clock.observe({ type: 'usage', inputTokens: 10, outputTokens: 1 });
        clock.observe({ type: 'turn_complete', stopReason: 'end_turn' });
        expect(clock.generationMs(0, 1_000)).toBeNull();
    });

    it('reports null when the round has no measurable span', () => {
        const clock = new GenerationClock(steppedClock().now);
        clock.observe(chunk());
        expect(clock.generationMs(5_000, 5_000)).toBeNull();
        expect(clock.generationMs(5_000, null)).toBeNull();
        expect(clock.generationMs(null, 5_000)).toBeNull();
    });
});