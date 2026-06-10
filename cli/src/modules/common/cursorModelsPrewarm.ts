import { logger } from '@/ui/logger';
import { listCursorModels } from './cursorModels';

/** Background fill of shared cursor-models cache; does not block runner startup. */
export function scheduleCursorModelsPrewarm(): void {
    void listCursorModels().catch((error) => {
        logger.debug('[RUNNER RUN] Cursor model pre-warm failed', error);
    });
}
