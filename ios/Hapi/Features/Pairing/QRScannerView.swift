import HapiProtocol
import SwiftUI
import UIKit
import Vision
import VisionKit

/// QR scanning step: a VisionKit live scanner that feeds every recognized
/// string through ``BindLink/parse(_:)`` (so both the companion deeplink QR
/// and the web direct-access QR pair) and pushes the shared confirm step on
/// success. Falls back to guidance when scanning is unsupported (Simulator,
/// no camera) or camera access is denied.
struct QRScannerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var scanned: PendingPairing?
    @State private var cameraDenied = false
    @State private var sawForeignCode = false

    var body: some View {
        NavigationStack {
            scannerContent
                .navigationTitle("Scan to Pair")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            dismiss()
                        }
                    }
                }
                .navigationDestination(item: $scanned) { pending in
                    PairingConfirmView(pending: pending)
                }
        }
    }

    @ViewBuilder
    private var scannerContent: some View {
        if DataScannerViewController.isSupported {
            DataScannerRepresentable(isActive: scanned == nil, onScan: handleScannedString)
                .ignoresSafeArea(edges: .bottom)
                .overlay(alignment: .bottom) {
                    hintBar
                }
                .overlay {
                    if cameraDenied {
                        cameraDeniedView
                    }
                }
                .task {
                    // Also triggers the camera permission prompt on first use.
                    cameraDenied = !(await DataScannerViewController.isAvailable)
                }
        } else {
            ContentUnavailableView {
                Label("Scanning unavailable", systemImage: "camera")
            } description: {
                Text("This device cannot scan QR codes (for example the Simulator). Go back and use manual entry instead.")
            } actions: {
                Button("Close") {
                    dismiss()
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var hintBar: some View {
        Text(sawForeignCode
            ? String(localized: "That code is not a HAPI pairing QR — scan one printed by the hub.")
            : String(localized: "Point the camera at the pairing QR from the hub terminal or the web app's Companion Pairing settings."))
            .font(.footnote)
            .multilineTextAlignment(.center)
            .foregroundStyle(sawForeignCode ? Color.orange : Color.secondary)
            .padding(12)
            .frame(maxWidth: .infinity)
            .background(.thinMaterial)
    }

    private var cameraDeniedView: some View {
        ContentUnavailableView {
            Label("Camera access denied", systemImage: "video.slash")
        } description: {
            Text("Allow camera access in Settings to scan the pairing QR, or go back and use manual entry.")
        } actions: {
            if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
                Button("Open Settings") {
                    openURL(settingsURL)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .background(.background)
    }

    /// Returns whether the payload was accepted (stops further scanning).
    private func handleScannedString(_ raw: String) -> Bool {
        guard scanned == nil else { return true }
        guard let link = BindLink.parse(raw) else {
            sawForeignCode = true
            return false
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        scanned = PendingPairing(
            hubUrl: link.hubUrl,
            accessToken: link.accessToken,
            source: .qrScan
        )
        return true
    }
}

/// `DataScannerViewController` wrapped for SwiftUI, restricted to QR codes.
/// `isActive` gates scanning so a successful scan freezes the camera while
/// the confirm step is up and re-arms when the user navigates back.
private struct DataScannerRepresentable: UIViewControllerRepresentable {
    var isActive: Bool
    var onScan: (String) -> Bool

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.onScan = onScan
        if isActive {
            context.coordinator.hasAccepted = false
            if !scanner.isScanning {
                // Throws when unavailable (permission denied etc.); the
                // SwiftUI layer surfaces that state, so failing quietly here
                // is fine.
                try? scanner.startScanning()
            }
        } else if scanner.isScanning {
            scanner.stopScanning()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan)
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onScan: (String) -> Bool
        var hasAccepted = false

        init(onScan: @escaping (String) -> Bool) {
            self.onScan = onScan
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            process(addedItems, scanner: dataScanner)
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didUpdate updatedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            process(updatedItems, scanner: dataScanner)
        }

        private func process(_ items: [RecognizedItem], scanner: DataScannerViewController) {
            guard !hasAccepted else { return }
            for item in items {
                guard case .barcode(let barcode) = item,
                      let payload = barcode.payloadStringValue else { continue }
                if onScan(payload) {
                    hasAccepted = true
                    scanner.stopScanning()
                    return
                }
            }
        }
    }
}
