/**
 * Client-side mirror of hub/src/push/notificationCopy.ts renderTemplate —
 * used for live preview of push copy templates. Unknown placeholders are
 * left as-is so a typo stays visible instead of vanishing.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
        return key in vars ? vars[key] : match
    })
}
