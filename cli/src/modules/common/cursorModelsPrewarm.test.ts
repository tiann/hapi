import { afterEach, describe, expect, test, vi } from 'vitest';

const listCursorModelsMock = vi.hoisted(() => vi.fn());

vi.mock('./cursorModels', () => ({
    listCursorModels: listCursorModelsMock
}));

import { scheduleCursorModelsPrewarm } from './cursorModelsPrewarm';

afterEach(() => {
    listCursorModelsMock.mockReset();
});

describe('scheduleCursorModelsPrewarm', () => {
    test('starts a background listCursorModels call', async () => {
        listCursorModelsMock.mockResolvedValue({
            success: true,
            availableModels: [],
            currentModelId: null
        });

        scheduleCursorModelsPrewarm();

        await Promise.resolve();

        expect(listCursorModelsMock).toHaveBeenCalledTimes(1);
    });

    test('swallows listCursorModels failures', async () => {
        listCursorModelsMock.mockRejectedValue(new Error('agent missing'));

        scheduleCursorModelsPrewarm();

        await Promise.resolve();

        expect(listCursorModelsMock).toHaveBeenCalledTimes(1);
    });
});
