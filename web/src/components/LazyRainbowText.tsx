import React, { useRef, useState, useEffect, useMemo } from 'react'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

const ULTRATHINK_PATTERN = /\b(ultrathink)\b/gi

// Each letter gets a different delay for wave effect
function RainbowWord({ word, baseKey }: { word: string; baseKey: number }) {
    const totalLetters = word.length
    const cycleDuration = 2 // seconds for sparkle to travel across all letters

    return (
        <span>
            {word.split('').map((letter, i) => {
                // Each letter has a different delay to create wave effect
                const colorDelay = (i / totalLetters) * 2 // stagger rainbow colors
                const sparkleDelay = (i / totalLetters) * cycleDuration // sparkle wave

                return (
                    <span
                        key={`${baseKey}-${i}`}
                        className="rainbow-letter"
                        style={{
                            animationDelay: `${-colorDelay}s, ${-sparkleDelay}s`,
                        }}
                    >
                        {letter}
                    </span>
                )
            })}
        </span>
    )
}

// Process text string to wrap "ultrathink" with RainbowWord
function processTextForRainbow(text: string): React.ReactNode {
    ULTRATHINK_PATTERN.lastIndex = 0
    const parts: React.ReactNode[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = ULTRATHINK_PATTERN.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push(text.slice(lastIndex, match.index))
        }
        parts.push(<RainbowWord key={match.index} word={match[1]} baseKey={match.index} />)
        lastIndex = match.index + match[0].length
    }

    if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex))
    }

    return <>{parts}</>
}

// Process React children to apply rainbow to text nodes
function processChildrenForRainbow(children: React.ReactNode): React.ReactNode {
    return React.Children.map(children, (child) => {
        if (typeof child === 'string') {
            return processTextForRainbow(child)
        }
        return child
    })
}

export function LazyRainbowText({ text }: { text: string }) {
    const ref = useRef<HTMLDivElement>(null)
    const [hasBeenVisible, setHasBeenVisible] = useState(false)

    useEffect(() => {
        const el = ref.current
        if (!el) return

        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setHasBeenVisible(true)
                }
            },
            { rootMargin: '100px' }
        )

        observer.observe(el)
        return () => observer.disconnect()
    }, [])

    // Quick check: if no ultrathink, just render markdown
    const hasUltrathink = text.toLowerCase().includes('ultrathink')

    const rainbowComponents = useMemo(() => ({
        p: ({ children }: { children?: React.ReactNode }) => (
            <p>{processChildrenForRainbow(children)}</p>
        ),
    }), [])

    return (
        <div ref={ref}>
            <MarkdownRenderer
                content={text}
                components={hasUltrathink && hasBeenVisible ? rainbowComponents : undefined}
            />
        </div>
    )
}
