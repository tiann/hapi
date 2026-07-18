import { describe, expect, it } from 'vitest';
import { shouldSurfaceGrokStderr } from './grokDiagnostics';

describe('shouldSurfaceGrokStderr', () => {
    it('hides Grok telemetry export failures from chat', () => {
        expect(shouldSurfaceGrokStderr('name="BatchSpanProcessor.ExportError" error="Operation failed: HTTP export failed: network error"'))
            .toBe(false);
    });

    it('does not hide stderr that only contains one telemetry marker', () => {
        expect(shouldSurfaceGrokStderr('HTTP export failed while uploading a user-requested artifact'))
            .toBe(true);
        expect(shouldSurfaceGrokStderr('BatchSpanProcessor.ExportError was mentioned by the model'))
            .toBe(true);
    });

    it('hides the non-fatal internal grok-build subscription diagnostic', () => {
        expect(shouldSurfaceGrokStderr(
            "responses API error status=403 Forbidden error_message=permission-denied: The model 'grok-build' requires a Grok subscription. model_id=grok-build"
        )).toBe(false);
    });

    it('keeps actionable Grok stderr visible', () => {
        expect(shouldSurfaceGrokStderr('responses API error status=402 Payment Required'))
            .toBe(true);
        expect(shouldSurfaceGrokStderr("The model 'grok-4.5' requires a Grok subscription"))
            .toBe(true);
    });
});
