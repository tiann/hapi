/**
 * Minimal server-side message catalog for the hub.
 *
 * The web app ships a full locale table; the hub only needs the handful of
 * user-facing strings it sends outside the web UI (Telegram bot, notification
 * previews). Keep it dependency-free so it can be imported from anywhere.
 */

export type HubLocale = 'en' | 'ru'

/**
 * Map a Telegram/BCP-47 language tag onto a hub locale. Unsupported languages
 * fall back to English.
 */
export function resolveHubLocale(languageCode: string | null | undefined): HubLocale {
    if (!languageCode) return 'en'
    const lower = languageCode.trim().toLowerCase().replace(/_/g, '-')
    if (lower === 'ru' || lower.startsWith('ru-')) return 'ru'
    return 'en'
}

const en = {
    'telegram.openApp': 'Open App',
    'telegram.openMiniApp': 'Open HAPI Mini App:',
    'telegram.welcome': 'Welcome to HAPI Bot!\n\nUse the Mini App for full session management.',
    'telegram.openSession': 'Open Session',
    'telegram.details': 'Details',
    'telegram.allow': 'Allow',
    'telegram.deny': 'Deny',
    'telegram.task.completed': 'Task completed',
    'telegram.task.failed': 'Task failed',
    'telegram.ready.noContext': "It's ready!\n\n{agent} is waiting for your command",
    'telegram.ready.heading': 'Ready: {heading}',
    'telegram.ready.waiting': '{agent} is waiting for your command',
    'telegram.permission.actionRequired': 'Action required: {heading}',
    'telegram.permission.requests': '{agent} requests permission',
    'telegram.permission.title': 'Permission Request',
    'telegram.session': 'Session: {name}',
    'telegram.path': 'Path: {path}',
    'telegram.tool': 'Tool: {tool}',
    'telegram.heading.on': '{session} on {machine}',
    'callback.notConnected': 'Not connected',
    'callback.notBound': 'Telegram account is not bound',
    'callback.sessionNotFound': 'Session not found',
    'callback.sessionInactive': 'Session is inactive',
    'callback.requestMissing': 'Request not found or already processed',
    'callback.approved': 'Approved!',
    'callback.denied': 'Denied',
    'callback.unknownAction': 'Unknown action',
    'callback.error': 'An error occurred',
    'callback.permissionApproved': 'Permission approved.',
    'callback.permissionDenied': 'Permission denied.',
    'inputRequest.title': '{agent} needs your input',
    'inputRequest.fallback': 'Open the session to view and answer the question.',
    'inputRequest.more.one': '+{count} more question',
    'inputRequest.more.few': '+{count} more questions',
    'inputRequest.more.many': '+{count} more questions',
    'inputRequest.more.other': '+{count} more questions',
    'toolArgs.file': 'File: {value}',
    'toolArgs.old': 'Old: "{value}"',
    'toolArgs.new': 'New: "{value}"',
    'toolArgs.command': 'Command: {value}',
    'toolArgs.task': 'Task: {value}',
    'toolArgs.pattern': 'Pattern: {value}',
    'toolArgs.path': 'Path: {value}',
    'toolArgs.url': 'URL: {value}',
    'toolArgs.args': 'Args: {value}',
    'toolArgs.chars': '{n} chars',
    'toolArgs.updatingTodos': 'Updating {n} todo items',
    'toolArgs.unknownFile': 'unknown',
    'push.ready.title': 'Ready for input',
    'push.ready.body': '{agent} is waiting in {session}',
    'push.permission.title': 'Permission Request',
    'push.task.completed': 'Task completed',
    'push.task.failed': 'Task failed',
    'native.session': 'Session: {name}'
} as const

export type HubMessageKey = keyof typeof en

const ru: Record<HubMessageKey, string> = {
    'telegram.openApp': 'Открыть приложение',
    'telegram.openMiniApp': 'Открыть HAPI Mini App:',
    'telegram.welcome': 'Добро пожаловать в HAPI Bot!\n\nИспользуйте Mini App для полноценного управления сессиями.',
    'telegram.openSession': 'Открыть сессию',
    'telegram.details': 'Подробнее',
    'telegram.allow': 'Разрешить',
    'telegram.deny': 'Отклонить',
    'telegram.task.completed': 'Задача выполнена',
    'telegram.task.failed': 'Задача завершилась с ошибкой',
    'telegram.ready.noContext': 'Готово!\n\n{agent} ждёт вашей команды',
    'telegram.ready.heading': 'Готово: {heading}',
    'telegram.ready.waiting': '{agent} ждёт вашей команды',
    'telegram.permission.actionRequired': 'Требуется действие: {heading}',
    'telegram.permission.requests': '{agent} запрашивает разрешение',
    'telegram.permission.title': 'Запрос разрешения',
    'telegram.session': 'Сессия: {name}',
    'telegram.path': 'Путь: {path}',
    'telegram.tool': 'Инструмент: {tool}',
    'telegram.heading.on': '{session} на {machine}',
    'callback.notConnected': 'Нет подключения',
    'callback.notBound': 'Telegram-аккаунт не привязан',
    'callback.sessionNotFound': 'Сессия не найдена',
    'callback.sessionInactive': 'Сессия неактивна',
    'callback.requestMissing': 'Запрос не найден или уже обработан',
    'callback.approved': 'Одобрено!',
    'callback.denied': 'Отклонено',
    'callback.unknownAction': 'Неизвестное действие',
    'callback.error': 'Произошла ошибка',
    'callback.permissionApproved': 'Разрешение одобрено.',
    'callback.permissionDenied': 'Разрешение отклонено.',
    'inputRequest.title': '{agent} ждёт вашего ответа',
    'inputRequest.fallback': 'Откройте сессию, чтобы посмотреть вопрос и ответить.',
    'inputRequest.more.one': '+ещё {count} вопрос',
    'inputRequest.more.few': '+ещё {count} вопроса',
    'inputRequest.more.many': '+ещё {count} вопросов',
    'inputRequest.more.other': '+ещё {count} вопросов',
    'toolArgs.file': 'Файл: {value}',
    'toolArgs.old': 'Было: "{value}"',
    'toolArgs.new': 'Стало: "{value}"',
    'toolArgs.command': 'Команда: {value}',
    'toolArgs.task': 'Задача: {value}',
    'toolArgs.pattern': 'Шаблон: {value}',
    'toolArgs.path': 'Путь: {value}',
    'toolArgs.url': 'URL: {value}',
    'toolArgs.args': 'Аргументы: {value}',
    'toolArgs.chars': '{n} символов',
    'toolArgs.updatingTodos': 'Обновление элементов todo: {n}',
    'toolArgs.unknownFile': 'неизвестно',
    'push.ready.title': 'Готов к вводу',
    'push.ready.body': '{agent} ждёт в сессии {session}',
    'push.permission.title': 'Запрос разрешения',
    'push.task.completed': 'Задача выполнена',
    'push.task.failed': 'Задача не удалась',
    'native.session': 'Сессия: {name}'
}

const catalogs: Record<HubLocale, Record<HubMessageKey, string>> = { en, ru }

export function hubT(
    locale: HubLocale,
    key: HubMessageKey,
    params?: Record<string, string | number>
): string {
    const template = catalogs[locale]?.[key] ?? en[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        params[name] !== undefined ? String(params[name]) : match
    )
}

export type PluralCategory = 'one' | 'few' | 'many' | 'other'

/** Count category for the locales in the catalog (Russian CLDR rules). */
export function hubPluralCategory(locale: HubLocale, count: number): PluralCategory {
    if (locale !== 'ru') {
        return count === 1 ? 'one' : 'other'
    }
    const mod10 = count % 10
    const mod100 = count % 100
    if (mod10 === 1 && mod100 !== 11) return 'one'
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'few'
    return 'many'
}
