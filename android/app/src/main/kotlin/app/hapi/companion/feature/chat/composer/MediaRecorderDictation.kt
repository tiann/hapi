package app.hapi.companion.feature.chat.composer

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/**
 * [DictationRecorder] over the framework [MediaRecorder]: AAC in an MPEG-4
 * container (`.m4a`), a format every hub transcription provider accepts (the
 * contract allows any `audio/` type or mp4; the web itself falls back to mp4
 * on Safari). Mono 44.1 kHz @ 96 kbps keeps minutes of speech far below the
 * endpoint's 25 MB cap. Requires `RECORD_AUDIO` — the composer requests it
 * before [start].
 */
class MediaRecorderDictation(private val context: Context) : DictationRecorder {
    override val filename: String = "speech.m4a"
    override val mimeType: String = "audio/mp4"

    private var recorder: MediaRecorder? = null
    private var output: File? = null

    override fun start() {
        check(recorder == null) { "recording already in progress" }
        val file = File.createTempFile("dictation-", ".m4a", context.cacheDir)
        val mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
        try {
            mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            mediaRecorder.setAudioChannels(1)
            mediaRecorder.setAudioSamplingRate(44_100)
            mediaRecorder.setAudioEncodingBitRate(96_000)
            mediaRecorder.setOutputFile(file.absolutePath)
            mediaRecorder.prepare()
            mediaRecorder.start()
        } catch (error: Exception) {
            mediaRecorder.release()
            file.delete()
            throw error
        }
        recorder = mediaRecorder
        output = file
    }

    override fun stop(): ByteArray? {
        val mediaRecorder = recorder ?: return null
        val file = output
        recorder = null
        output = null
        try {
            mediaRecorder.stop()
        } catch (_: Exception) {
            // stop() throws when no valid audio landed (stopped immediately
            // after start) — treat as an empty take.
            file?.delete()
            return null
        } finally {
            mediaRecorder.release()
        }
        val bytes = try {
            file?.takeIf { it.exists() }?.readBytes()
        } finally {
            file?.delete()
        }
        return bytes?.takeIf { it.isNotEmpty() }
    }

    override fun cancel() {
        val mediaRecorder = recorder ?: return
        recorder = null
        runCatching { mediaRecorder.stop() }
        mediaRecorder.release()
        output?.delete()
        output = null
    }
}
