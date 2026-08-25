package app.hapi.protocol.wire

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * Epoch-milliseconds field that the hub may deliver as a **fractional**
 * number: anything derived from `fs.stat` `mtimeMs` (file `modified`,
 * machine `startedCliMtimeMs`/`installedCliMtimeMs`) carries sub-millisecond
 * precision, e.g. `1786932205158.1177` — observed in real hub data. zod's
 * `z.number()` accepts that; a plain Kotlin `Long` decode throws and (before
 * this) took the whole machines/files response down with it.
 *
 * Decodes any JSON number and truncates to ms. Encoding writes a plain long
 * (we never need to reproduce the fraction).
 */
object LenientEpochMs : KSerializer<Long> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("app.hapi.protocol.wire.LenientEpochMs", PrimitiveKind.DOUBLE)

    override fun deserialize(decoder: Decoder): Long = decoder.decodeDouble().toLong()

    override fun serialize(encoder: Encoder, value: Long) {
        encoder.encodeLong(value)
    }
}
