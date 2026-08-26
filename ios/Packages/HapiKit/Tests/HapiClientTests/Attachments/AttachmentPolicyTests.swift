import Foundation
import HapiClient
import Testing

private let mb = 1024 * 1024

/// Pure compression/sizing decisions (A-M3f) — transcription of the Android
/// `AttachmentPolicyTest`; the preparer defers to these.
@Suite("AttachmentPolicy")
struct AttachmentPolicyTests {

    // MARK: - plan(forMimeType:sizeBytes:)

    @Test func smallFilesOfAnyTypeKeepTheirOriginalBytes() {
        #expect(AttachmentPolicy.plan(forMimeType: "image/jpeg", sizeBytes: 3 * mb) == .keepOriginal)
        #expect(AttachmentPolicy.plan(forMimeType: "application/pdf", sizeBytes: 20 * mb) == .keepOriginal)
        #expect(AttachmentPolicy.plan(forMimeType: "text/plain", sizeBytes: 10) == .keepOriginal)
    }

    @Test func imagesOverThe4MBThresholdAreCompressed() {
        #expect(AttachmentPolicy.plan(forMimeType: "image/jpeg", sizeBytes: 5 * mb) == .compressImage)
        #expect(AttachmentPolicy.plan(forMimeType: "image/png", sizeBytes: 12 * mb) == .compressImage)
        #expect(AttachmentPolicy.plan(forMimeType: "image/webp", sizeBytes: 4 * mb + 1) == .compressImage)
        // Case-insensitive mime match.
        #expect(AttachmentPolicy.plan(forMimeType: "image/JPEG", sizeBytes: 5 * mb) == .compressImage)
    }

    @Test func imagesAtExactlyTheThresholdStayOriginal() {
        #expect(AttachmentPolicy.plan(forMimeType: "image/jpeg", sizeBytes: 4 * mb) == .keepOriginal)
    }

    @Test func oversizedRecompressibleImagesAreStillCompressedNotRejected() {
        // Downscaling brings any camera photo far under the cap; the preparer
        // re-checks the compressed size against the 50 MB contract.
        #expect(AttachmentPolicy.plan(forMimeType: "image/jpeg", sizeBytes: 60 * mb) == .compressImage)
    }

    @Test func oversizedNonRecompressibleFilesAreRejected() {
        #expect(AttachmentPolicy.plan(forMimeType: "application/zip", sizeBytes: 51 * mb) == .reject)
        #expect(AttachmentPolicy.plan(forMimeType: "video/mp4", sizeBytes: 200 * mb) == .reject)
        // GIF recompression would drop animation — over-cap GIFs reject.
        #expect(AttachmentPolicy.plan(forMimeType: "image/gif", sizeBytes: 51 * mb) == .reject)
    }

    @Test func filesAtExactly50MBPass() {
        #expect(AttachmentPolicy.plan(forMimeType: "application/zip", sizeBytes: 50 * mb) == .keepOriginal)
    }

    @Test func gifsUnderTheCapKeepOriginalBytesRegardlessOfSize() {
        #expect(AttachmentPolicy.plan(forMimeType: "image/gif", sizeBytes: 30 * mb) == .keepOriginal)
    }

    @Test func readCapAllowsOversizedSourcesOnlyForRecompressibleImages() {
        #expect(AttachmentPolicy.readCap(forMimeType: "image/jpeg") == AttachmentPolicy.maxImageSourceBytes)
        #expect(AttachmentPolicy.readCap(forMimeType: "image/gif") == AttachmentPolicy.maxUploadBytes)
        #expect(AttachmentPolicy.readCap(forMimeType: "video/mp4") == AttachmentPolicy.maxUploadBytes)
        #expect(AttachmentPolicy.readCap(forMimeType: "application/pdf") == AttachmentPolicy.maxUploadBytes)
    }

    // MARK: - Scaling

    @Test func scaledDimensionsClampsTheLongestEdgeAndPreservesAspect() {
        #expect(AttachmentPolicy.scaledDimensions(width: 4096, height: 3072, maxDimension: 2048) == (2048, 1536))
        #expect(AttachmentPolicy.scaledDimensions(width: 2048, height: 4096, maxDimension: 2048) == (1024, 2048))
        // Under the cap: untouched.
        #expect(AttachmentPolicy.scaledDimensions(width: 640, height: 480, maxDimension: 2048) == (640, 480))
        // Degenerate aspect never collapses to zero.
        #expect(AttachmentPolicy.scaledDimensions(width: 100_000, height: 10, maxDimension: 2048) == (2048, 1))
    }

    // MARK: - Filenames

    @Test func compressedFilenameSwapsTheExtensionToJpg() {
        #expect(AttachmentPolicy.compressedFilename("shot.png") == "shot.jpg")
        #expect(AttachmentPolicy.compressedFilename("IMG_0001.HEIC") == "IMG_0001.jpg")
        #expect(AttachmentPolicy.compressedFilename("photo.jpg") == "photo.jpg")
        #expect(AttachmentPolicy.compressedFilename("archive.tar.png") == "archive.tar.jpg")
        #expect(AttachmentPolicy.compressedFilename("noext") == "noext.jpg")
        // A leading dot is a hidden-file name, not an extension.
        #expect(AttachmentPolicy.compressedFilename(".hidden") == ".hidden.jpg")
    }

    // MARK: - Data URLs

    @Test func dataUrlAndBytesFromDataUrlRoundTrip() {
        let bytes = Data([1, 2, 3, 4, 5])
        let url = AttachmentPolicy.dataUrl(mimeType: "image/jpeg", bytes: bytes)
        #expect(url == "data:image/jpeg;base64,AQIDBAU=")
        #expect(AttachmentPolicy.bytesFromDataUrl(url) == bytes)
    }

    @Test func webAuthoredDataUrlsParseRegardlessOfMime() {
        #expect(AttachmentPolicy.base64FromDataUrl("data:image/png;base64,iVBORw0K") == "iVBORw0K")
    }

    @Test func nonDataUrlsAndMalformedPayloadsReturnNil() {
        #expect(AttachmentPolicy.base64FromDataUrl("https://example.com/a.png") == nil)
        #expect(AttachmentPolicy.base64FromDataUrl("data:image/png,plain") == nil)
        #expect(AttachmentPolicy.base64FromDataUrl("data:image/png;base64,") == nil)
        #expect(AttachmentPolicy.bytesFromDataUrl("data:image/png;base64,!!!not-base64!!!") == nil)
    }
}
