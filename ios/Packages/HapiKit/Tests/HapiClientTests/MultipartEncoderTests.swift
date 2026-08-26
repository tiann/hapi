import Foundation
import HapiClient
import Testing

@Suite("MultipartFormData")
struct MultipartEncoderTests {
    @Test func encodesFieldsAndOneFilePart() {
        var form = MultipartFormData(boundary: "B")
        form.appendField(name: "provider", value: "openai")
        form.appendField(name: "mode", value: "standard")
        form.appendFile(
            fieldName: "file",
            filename: "clip.m4a",
            mimeType: "audio/mp4",
            data: Data([0x01, 0x02])
        )

        var expected = Data(
            (
                "--B\r\n"
                    + "Content-Disposition: form-data; name=\"provider\"\r\n\r\n"
                    + "openai\r\n"
                    + "--B\r\n"
                    + "Content-Disposition: form-data; name=\"mode\"\r\n\r\n"
                    + "standard\r\n"
                    + "--B\r\n"
                    + "Content-Disposition: form-data; name=\"file\"; filename=\"clip.m4a\"\r\n"
                    + "Content-Type: audio/mp4\r\n\r\n"
            ).utf8
        )
        expected.append(Data([0x01, 0x02]))
        expected.append(Data("\r\n--B--\r\n".utf8))

        #expect(form.contentType == "multipart/form-data; boundary=B")
        #expect(form.encodedBody() == expected)
    }

    @Test func encodingDoesNotConsumeTheBuilder() {
        var form = MultipartFormData(boundary: "B")
        form.appendField(name: "a", value: "1")
        let first = form.encodedBody()
        #expect(form.encodedBody() == first)
    }

    @Test func sanitizesQuotesAndCRLFInHeaderValues() {
        var form = MultipartFormData(boundary: "B")
        form.appendFile(
            fieldName: "file",
            filename: "we\"ird\r\nname.m4a",
            mimeType: "audio/mp4",
            data: Data()
        )
        let body = String(decoding: form.encodedBody(), as: UTF8.self)
        #expect(body.contains("filename=\"we%22irdname.m4a\""))
    }

    @Test func generatedBoundariesAreUnique() {
        #expect(MultipartFormData.makeBoundary() != MultipartFormData.makeBoundary())
    }
}
