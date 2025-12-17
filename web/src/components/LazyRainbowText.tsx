import React, { useRef, useState, useEffect, useMemo } from 'react'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

// 特效单词列表 - 可以轻松扩展
const RAINBOW_WORDS = [
    'ultrathink',
    'fuck',
    'step by step',
    'ELI5',
    'lgtm',
    'impl it',
    'pls fix',
    'stop changing',
    '用中文',
    '我说了',
    '别又',
    '为什么又',
    '根本不',
    '还是报错',
    '大哥',
    '求你',
    '就改这里',
    '弱智',
]

// 转义正则特殊字符
function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 动态构建正则表达式
function buildPattern(words: string[]): RegExp {
    const pattern = words.map(escapeRegExp).join('|')
    return new RegExp(`(${pattern})`, 'gi')
}

// 快速检查是否包含任何特效单词
function hasAnySpecialWord(text: string, words: string[]): boolean {
    const lowerText = text.toLowerCase()
    return words.some(word => lowerText.includes(word.toLowerCase()))
}

const RAINBOW_PATTERN = buildPattern(RAINBOW_WORDS)

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
                        {letter === ' ' ? '\u00A0' : letter}
                    </span>
                )
            })}
        </span>
    )
}

// Process text string to wrap special words with RainbowWord
function processTextForRainbow(text: string): React.ReactNode {
    RAINBOW_PATTERN.lastIndex = 0
    const parts: React.ReactNode[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = RAINBOW_PATTERN.exec(text)) !== null) {
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

    // Quick check: if no special words, just render markdown
    const hasSpecialWord = hasAnySpecialWord(text, RAINBOW_WORDS)

    const rainbowComponents = useMemo(() => ({
        p: ({ children }: { children?: React.ReactNode }) => (
            <p>{processChildrenForRainbow(children)}</p>
        ),
    }), [])

    return (
        <div ref={ref}>
            <MarkdownRenderer
                content={text}
                components={hasSpecialWord && hasBeenVisible ? rainbowComponents : undefined}
            />
        </div>
    )
}
