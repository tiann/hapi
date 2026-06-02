import type { ConsoleLogEntry } from '../../shared'
import type { Dictionary } from '../i18n'

type Props = {
    logs: ConsoleLogEntry[]
    dict: Dictionary
    onClear: () => void
}

export function ConsoleLog({ logs, dict, onClear }: Props) {
    return (
        <section className="console-card">
            <div className="console-header">
                <h2>{dict.homePage.console}</h2>
                <button className="secondary-dark-button" type="button" onClick={onClear}>{dict.homePage.clear}</button>
            </div>
            <div className="console-body">
                {logs.length === 0 ? (
                    <div className="log-line log-system">{dict.homePage.waiting}</div>
                ) : logs.map((entry) => (
                    <div className={`log-line log-${entry.source}`} key={entry.id}>{entry.text}</div>
                ))}
            </div>
        </section>
    )
}
