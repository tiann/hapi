/**
 * 选中文本引用（quote selection）的数据层。
 *
 * 引用刻意不走 assistant-ui 的 attachments：那个 API 的 `type` 是封闭联合
 * 且 `PendingAttachment.file` 必须是真 File，塞引用进去要伪造合成 File，
 * 还会连累 attachmentDrafts（把假 blob 写进 IndexedDB）和 hasAttachments
 * （它门控定时发送，而引用是纯文本不该受限）。
 */

export type Quote = {
    id: string
    /** 用户选中的原始文本，不做任何裁剪 */
    text: string
    /** 来源消息的 anchor id，用于点击 chip 跳回原文 */
    messageId: string
    createdAt: number
}

/**
 * 逐行加 `> ` 前缀，而不是整块包裹——这样引文内部的 fenced code block
 * 仍然合法，缩进也得以保留。空行输出裸 `>`（不带尾随空格），否则
 * blockquote 会在空行处断开成两块。
 */
function blockquote(text: string): string {
    return text
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n')
}

/**
 * 把引用列表 + 正文序列化成最终发给 agent 的文本。
 *
 * 只有 ≥2 条时才加 `[N]` 编号：单条时编号是纯噪音；多条时编号让 agent
 * 能明确数出引用数量并用编号指代。用纯符号而非「引用 N」/「Quote N」，
 * 零语言依赖，无需新增 i18n key。
 *
 * 序列化发生在**发送时**而非引用时，所以加入第 2 条引用会让第 1 条
 * 追溯性地获得编号——这是 chip 方案独有的能力，纯文本累加做不到。
 */
export function serializeQuotes(quotes: readonly Quote[], body: string): string {
    if (quotes.length === 0) return body
    const numbered = quotes.length > 1
    const blocks = quotes.map((quote, index) =>
        blockquote(numbered ? `**[${index + 1}]**\n${quote.text}` : quote.text)
    )
    return `${blocks.join('\n\n')}\n\n${body}`
}
