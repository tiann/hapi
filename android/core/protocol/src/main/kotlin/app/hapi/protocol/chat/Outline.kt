package app.hapi.protocol.chat

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Conversation outline: the locatable user messages of a thread in stored
 * order, each reduced to a short navigable label. The outline covers the
 * loaded message window only; loading older messages extends it.
 */

/** One navigable outline entry: one user message. */
data class ConversationOutlineItem(
    /** Stable list key, `outline:user-text:{blockId}`. */
    val id: String,
    /** Block to reveal in the transcript when this entry is picked. */
    val targetBlockId: String,
    /** Collapsed, truncated one-line summary of the message text. */
    val label: String,
    /** Hub receive time of the message, epoch milliseconds. */
    val createdAt: Long,
)

/** Labels never exceed this many characters (ellipsis included). */
const val MAX_OUTLINE_LABEL_LENGTH = 96

/** Label used when a message carries nothing but whitespace. */
const val EMPTY_OUTLINE_LABEL = "Empty message"

/**
 * Whitespace as whitespace-matching regular expressions define it in the
 * label normalization: ASCII controls, the space, and the Unicode space
 * separators. One shared definition so collapse and trim agree.
 */
private fun isOutlineWhitespace(c: Char): Boolean = when (c) {
    ' ', '\t', '\n', '\u000B', '\u000C', '\r',
    ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿',
    -> true
    else -> c in ' '..' '
}

/** Every run of whitespace becomes one space; leading/trailing runs drop. */
fun collapseOutlineWhitespace(value: String): String {
    val builder = StringBuilder(value.length)
    var inRun = false
    for (c in value) {
        if (isOutlineWhitespace(c)) {
            inRun = true
        } else {
            if (inRun && builder.isNotEmpty()) builder.append(' ')
            inRun = false
            builder.append(c)
        }
    }
    return builder.toString()
}

/**
 * Outline label: collapse whitespace first, then cap at [maxLength] with
 * three trailing dots. The cut keeps `maxLength - 3` characters and drops
 * trailing whitespace before the dots, so a result can end up shorter than
 * the cap but never longer.
 */
fun truncateOutlineLabel(
    value: String,
    maxLength: Int = MAX_OUTLINE_LABEL_LENGTH,
): String {
    val normalized = collapseOutlineWhitespace(value)
    if (normalized.length <= maxLength) return normalized
    val keep = (maxLength - 3).coerceAtLeast(0)
    return normalized.take(keep).trimEnd(::isOutlineWhitespace) + "..."
}

/**
 * A user message is addressable once it has a place in the thread: rows
 * queued for a later turn (never invoked, not failed) still belong to the
 * composer bar and have nothing to scroll to yet.
 */
fun isLocatableOutlineBlock(block: UserTextBlock): Boolean =
    !(block.invokedAt == null && block.status != "failed")

/**
 * Outline entries for a reduced block tree: one per locatable user message,
 * stored order preserved. Every other block kind (agent text, reasoning,
 * tool calls, events) is skipped — titles, summaries and status events are
 * not conversation landmarks.
 */
fun buildConversationOutline(blocks: List<ChatBlock>): List<ConversationOutlineItem> {
    val items = mutableListOf<ConversationOutlineItem>()
    for (block in blocks) {
        if (block is UserTextBlock && isLocatableOutlineBlock(block)) {
            items.add(
                ConversationOutlineItem(
                    id = "outline:user-text:${block.id}",
                    targetBlockId = block.id,
                    label = truncateOutlineLabel(block.text).ifEmpty { EMPTY_OUTLINE_LABEL },
                    createdAt = block.createdAt,
                )
            )
        }
    }
    return items
}

/** Date shapes the outline timestamp comes in, one per supported language. */
private enum class OutlineTimestampLanguage { ZH, RU, EN }

/** `zh*` and `ru*` region variants collapse onto their base shape; else the default. */
private fun outlineTimestampLanguage(languageTag: String): OutlineTimestampLanguage = when {
    languageTag.startsWith("zh", ignoreCase = true) -> OutlineTimestampLanguage.ZH
    languageTag.startsWith("ru", ignoreCase = true) -> OutlineTimestampLanguage.RU
    else -> OutlineTimestampLanguage.EN
}

private val OUTLINE_TIME_FORMAT = DateTimeFormatter.ofPattern("HH:mm")

/**
 * Timestamp shown next to an outline entry: time alone on the current day,
 * otherwise a compact locale-shaped date plus time. Month and day are
 * two digits, the year is not padded, and the time is always 24-hour.
 */
fun formatOutlineTimestamp(
    epochMs: Long,
    languageTag: String,
    nowEpochMs: Long = System.currentTimeMillis(),
    zone: ZoneId = ZoneId.systemDefault(),
): String {
    val dateTime = Instant.ofEpochMilli(epochMs).atZone(zone)
    val now = Instant.ofEpochMilli(nowEpochMs).atZone(zone)
    val time = dateTime.toLocalTime().format(OUTLINE_TIME_FORMAT)
    if (dateTime.toLocalDate() == now.toLocalDate()) return time

    val year = dateTime.year.toString()
    val month = dateTime.monthValue.toString().padStart(2, '0')
    val day = dateTime.dayOfMonth.toString().padStart(2, '0')
    val sameYear = dateTime.year == now.year
    val dateLabel = when (outlineTimestampLanguage(languageTag)) {
        OutlineTimestampLanguage.ZH ->
            if (sameYear) "${month}月${day}日" else "${year}年${month}月${day}日"
        OutlineTimestampLanguage.RU ->
            if (sameYear) "$day.$month" else "$day.$month.$year"
        OutlineTimestampLanguage.EN ->
            if (sameYear) "$month/$day" else "$year/$month/$day"
    }
    return "$dateLabel $time"
}
