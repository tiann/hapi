import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { getTelegramWebApp } from '@/hooks/useTelegram'

export function ChatInput(props: {
    disabled?: boolean
    onSend: (text: string) => void
}) {
    const [text, setText] = useState('')

    const trimmed = text.trim()

    const send = () => {
        if (!trimmed) return
        getTelegramWebApp()?.HapticFeedback?.impactOccurred('light')
        props.onSend(trimmed)
        setText('')
    }

    return (
        <div className="border-t border-[var(--app-border)] bg-[var(--app-bg)] p-2">
            <div className="flex items-end gap-2">
                <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Type a message..."
                    className="flex-1 resize-none rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                    rows={1}
                    disabled={props.disabled}
                    onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        if (e.shiftKey) return
                        e.preventDefault()
                        send()
                    }}
                />
                <Button
                    onClick={send}
                    disabled={props.disabled || !trimmed}
                >
                    Send
                </Button>
            </div>
        </div>
    )
}
