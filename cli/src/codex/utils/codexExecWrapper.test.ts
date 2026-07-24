import { describe, expect, it } from 'vitest';
import { countHookCoveredExecCalls, isFullyHookCoveredExecSource } from './codexExecWrapper';

describe('isFullyHookCoveredExecSource', () => {
    it('accepts direct and parallel hook-covered calls', () => {
        const source = `
            const calls = [
                tools.exec_command({ cmd: 'pwd' }),
                tools.apply_patch('*** Begin Patch')
            ];
            await Promise.all(calls);
        `;

        expect(isFullyHookCoveredExecSource(source)).toBe(true);
        expect(countHookCoveredExecCalls(source)).toBe(2);
    });

    it('accepts literal MCP property access', () => {
        expect(isFullyHookCoveredExecSource(`
            await tools.mcp__hapi__change_title({ title: 'Title' });
        `)).toBe(true);
        expect(isFullyHookCoveredExecSource(`
            await tools['mcp__hapi__change_title']({ title: 'Title' });
        `)).toBe(true);
    });

    it('accepts mixed plan and command wrappers', () => {
        expect(isFullyHookCoveredExecSource(`
            await tools.update_plan({ plan: [] });
            await tools.exec_command({ cmd: 'pwd' });
        `)).toBe(true);
    });

    it('accepts dynamically registered literal tool names', () => {
        expect(isFullyHookCoveredExecSource('await tools.view_image({ path: "/tmp/a.png" });')).toBe(true);
        expect(isFullyHookCoveredExecSource('await tools.get_goal({});')).toBe(true);
        expect(countHookCoveredExecCalls('await tools.view_image({ path: "/tmp/a.png" });')).toBe(1);
    });

    it('retains wrappers with dynamic tool access', () => {
        expect(isFullyHookCoveredExecSource('await tools[selectedTool](input);')).toBe(false);
        expect(isFullyHookCoveredExecSource('const registry = tools;')).toBe(false);
    });
});
