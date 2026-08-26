import SwiftUI
import UIKit

/// Camera capture for composer attachments (A-M3f): `UIImagePickerController`
/// restricted to the camera source (`PhotosPicker` has no capture mode), the
/// Android `TakePicture` analogue. The still is handed back as JPEG bytes and
/// then flows through the normal `AttachmentPreparer` policy (a >4 MB shot
/// gets downscaled/recompressed like any other image).
///
/// Requires `NSCameraUsageDescription` (present in Info.plist since the QR
/// pairing scanner). Present inside a `fullScreenCover` and check
/// ``isAvailable`` first — the Simulator has no camera.
struct CameraCaptureView: UIViewControllerRepresentable {
    /// JPEG bytes of the capture (already dismissed when called).
    var onCapture: (Data) -> Void

    @Environment(\.dismiss) private var dismiss

    static var isAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {
        context.coordinator.onCapture = onCapture
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, dismiss: { dismiss() })
    }

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        var onCapture: (Data) -> Void
        let dismiss: () -> Void

        init(onCapture: @escaping (Data) -> Void, dismiss: @escaping () -> Void) {
            self.onCapture = onCapture
            self.dismiss = dismiss
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            let image = info[.originalImage] as? UIImage
            dismiss()
            // Full-quality first encode; the preparer's policy decides whether
            // the result needs the 2048 px recompression pass.
            guard let data = image?.jpegData(compressionQuality: 0.9) else { return }
            onCapture(data)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            dismiss()
        }
    }
}
