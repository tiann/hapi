import type { Locale } from '@/lib/use-translation'

export interface Voice {
    id: string
    name: string
    gender: 'female' | 'male'
    description: string
    aliases?: Partial<Record<Locale, string>>
}

export const VOICES: Voice[] = [
    {
        id: 'cgSgspJ2msm6clMCkdW9',
        name: 'Jessica',
        aliases: { 'zh-CN': '杰西卡' },
        gender: 'female',
        description: 'Default — warm, conversational',
    },
    {
        id: '21m00Tcm4TlvDq8ikWAM',
        name: 'Rachel',
        aliases: { 'zh-CN': '瑞秋' },
        gender: 'female',
        description: 'Calm, professional',
    },
    {
        id: 'EXAVITQu4vr4xnSDxMaL',
        name: 'Bella',
        aliases: { 'zh-CN': '贝拉' },
        gender: 'female',
        description: 'Soft, warm',
    },
    {
        id: 'TxGEqnHWrfWFTfGW9XjX',
        name: 'Josh',
        aliases: { 'zh-CN': '乔什' },
        gender: 'male',
        description: 'Deep, smooth',
    },
    {
        id: 'pNInz6obpgDQGcFmaJgB',
        name: 'Adam',
        aliases: { 'zh-CN': '亚当' },
        gender: 'male',
        description: 'Narration, clear',
    },
    { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi', gender: 'female', description: 'Strong, confident' },
    { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli', gender: 'female', description: 'Young, clear' },
    { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', gender: 'male', description: 'Crisp, authoritative' },
    { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', gender: 'male', description: 'Well-rounded' },
    { id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam', gender: 'male', description: 'Raspy, dynamic' },
]

export const DEFAULT_VOICE_ID = 'cgSgspJ2msm6clMCkdW9'

export function getVoiceById(id: string | null): Voice | undefined {
    return VOICES.find(v => v.id === id)
}

export function getFallbackVoices(locale: Locale): Voice[] {
    return VOICES.map((voice) => ({
        ...voice,
        name: voice.aliases?.[locale] ?? voice.name,
    }))
}
