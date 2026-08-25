package app.hapi.companion.feature.pairing

import com.journeyapps.barcodescanner.CaptureActivity

/**
 * zxing-android-embedded pins its stock `CaptureActivity` to sensorLandscape
 * in the library manifest; this empty subclass gets its own manifest entry
 * with `screenOrientation="portrait"` so the pairing scan matches the rest of
 * the (portrait) flow. Selected via `ScanOptions.setCaptureActivity`.
 */
class PortraitCaptureActivity : CaptureActivity()
