package app.hapi.companion.feature.chat.composer

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import kotlin.concurrent.thread

/**
 * [StreamingAudioSource] over [AudioRecord]: raw PCM16 mono 16 kHz — the
 * `encoding=linear16&sample_rate=16000&channels=1` contract the deepgram
 * listen URL pins. Requires `RECORD_AUDIO`, granted before [startCapture].
 * Single-take like every other dictation seam.
 */
internal class AudioRecordStreamingSource : StreamingAudioSource {
    private var recorder: AudioRecord? = null
    private var reader: Thread? = null

    @Volatile private var capturing = false

    @SuppressLint("MissingPermission") // RECORD_AUDIO is requested by the composer before start.
    override fun startCapture(onChunk: (ByteArray) -> Unit) {
        check(!capturing) { "capture already in progress" }
        val bufferBytes = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_MASK, ENCODING)
            .coerceAtLeast(4_096)
        val record = AudioRecord(
            android.media.MediaRecorder.AudioSource.MIC,
            SAMPLE_RATE,
            CHANNEL_MASK,
            ENCODING,
            bufferBytes,
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw IllegalStateException("microphone unavailable")
        }
        recorder = record
        record.startRecording()
        capturing = true
        // 1_600 bytes = 50 ms of PCM16 mono @ 16 kHz — short enough that the
        // bounded join in stopCapture stays snappy.
        reader = thread(name = "dictation-pcm") {
            val buffer = ByteArray(1_600)
            while (capturing) {
                val read = record.read(buffer, 0, buffer.size)
                if (read > 0) onChunk(buffer.copyOf(read)) else if (read < 0) break
            }
        }
    }

    override fun stopCapture() {
        if (!capturing) return
        capturing = false
        // Joins the reader so the last in-flight chunk is delivered before
        // this returns (the seam's Finalize-ordering contract). A blocked
        // read wakes within one 50 ms chunk.
        reader?.join()
    }

    override fun release() {
        if (capturing) stopCapture()
        recorder?.let { record ->
            runCatching { record.stop() }
            record.release()
        }
        recorder = null
        reader = null
    }

    private companion object {
        const val SAMPLE_RATE = 16_000
        const val CHANNEL_MASK = AudioFormat.CHANNEL_IN_MONO
        const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }
}
