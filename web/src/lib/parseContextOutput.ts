export type ContextCategory = {
    name: string
    tokens: number
    percentage: number
}

export type ContextDetailRow = {
    name: string
    extra?: string
    tokens: number
}

export type ContextSection = {
    title: string
    columns: string[]
    rows: ContextDetailRow[]
}

export type ContextData = {
    model: string | null
    totalTokens: number
    maxTokens: number
    usagePercentage: number
    categories: ContextCategory[]
    sections: ContextSection[]
}

function parseTokens(str: string): number {
    const cleaned = str.replace(/,/g, '').trim()
    const kMatch = cleaned.match(/^([\d.]+)k$/i)
    if (kMatch) {
        return Math.round(parseFloat(kMatch[1]) * 1000)
    }
    const mMatch = cleaned.match(/^([\d.]+)m$/i)
    if (mMatch) {
        return Math.round(parseFloat(mMatch[1]) * 1000000)
    }
    const num = parseInt(cleaned, 10)
    return isNaN(num) ? 0 : num
}

function parsePercentage(str: string): number {
    const match = str.match(/([\d.]+)%/)
    if (match) {
        return parseFloat(match[1])
    }
    return 0
}

function parseTableRows(lines: string[]): string[][] {
    const rows: string[][] = []
    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('|') || trimmed.startsWith('|--') || trimmed.startsWith('| --') || /^\|[-\s|]+\|$/.test(trimmed)) {
            continue
        }
        const cells = trimmed
            .split('|')
            .slice(1, -1) // remove leading/trailing empty from split
            .map(cell => cell.trim())
        if (cells.length > 0) {
            rows.push(cells)
        }
    }
    return rows
}

export function parseContextOutput(text: string): ContextData | null {
    // Extract stdout content from CLI tags
    const stdoutMatch = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i)
    const content = stdoutMatch ? stdoutMatch[1] : text

    // Parse model
    const modelMatch = content.match(/\*\*Model:\*\*\s*(\S+)/i)
    const model = modelMatch ? modelMatch[1] : null

    // Parse total tokens
    const tokensMatch = content.match(/\*\*Tokens:\*\*\s*([\d,.]+k?)\s*\/\s*([\d,.]+k?)\s*\(([\d.]+)%\)/i)
    if (!tokensMatch) {
        return null
    }

    const totalTokens = parseTokens(tokensMatch[1])
    const maxTokens = parseTokens(tokensMatch[2])
    const usagePercentage = parseFloat(tokensMatch[3])

    // Parse estimated usage table
    const categories: ContextCategory[] = []
    const categoryTableMatch = content.match(/### Estimated usage by category\s*\n([\s\S]*?)(?=\n###|\n## |$)/)
    if (categoryTableMatch) {
        const rows = parseTableRows(categoryTableMatch[1].split('\n'))
        // Skip header row
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]
            if (row.length >= 3) {
                categories.push({
                    name: row[0],
                    tokens: parseTokens(row[1]),
                    percentage: parsePercentage(row[2])
                })
            }
        }
    }

    // Parse detail sections (MCP Tools, Custom Agents, Memory Files, Skills)
    const sections: ContextSection[] = []
    const sectionRegex = /### ([\w\s]+)\s*\n([\s\S]*?)(?=\n###|\n## |$)/g
    let sectionMatch
    while ((sectionMatch = sectionRegex.exec(content)) !== null) {
        const title = sectionMatch[1].trim()
        if (title === 'Estimated usage by category') continue

        const rows = parseTableRows(sectionMatch[2].split('\n'))
        if (rows.length < 2) continue

        const columns = rows[0]
        const detailRows: ContextDetailRow[] = []
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i]
            if (row.length >= 2) {
                const tokensCol = row[row.length - 1]
                const name = row[0]
                const extra = row.length >= 3 ? row.slice(1, -1).join(' / ') : undefined
                detailRows.push({
                    name,
                    extra,
                    tokens: parseTokens(tokensCol)
                })
            }
        }
        if (detailRows.length > 0) {
            sections.push({ title, columns, rows: detailRows })
        }
    }

    return {
        model,
        totalTokens,
        maxTokens,
        usagePercentage,
        categories,
        sections
    }
}
