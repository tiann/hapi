import AuthenticationServices
import HapiClient
import UIKit

/// AuthenticationServices implementation of ``PasskeyAuthenticating``.
///
/// Native passkeys live on the shared RP ID `auth.hapi.run`
/// (`webcredentials:auth.hapi.run` in the Associated Domains entitlement, backed by
/// `https://auth.hapi.run/.well-known/apple-app-site-association`); the system
/// reports the origin `https://auth.hapi.run`, which every hub accepts. Options
/// arrive already RP-checked and decoded (``PasskeyRegistrationRequest`` /
/// ``PasskeyAssertionRequest``); this type only drives the system sheet and
/// returns raw bytes for HapiClient to encode as base64url JSON.
struct PlatformPasskeyAuthenticator: PasskeyAuthenticating {
    func register(_ request: PasskeyRegistrationRequest) async throws -> PasskeyRegistrationResult {
        let authorization = try await PasskeyCeremony.perform {
            let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
                relyingPartyIdentifier: request.relyingPartyID
            )
            let registration = provider.createCredentialRegistrationRequest(
                challenge: request.challenge,
                name: request.userName,
                userID: request.userID
            )
            registration.userVerificationPreference = .required
            if #available(iOS 17.4, macCatalyst 17.4, *) {
                registration.excludedCredentials = request.excludedCredentialIDs.map {
                    ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
                }
            }
            return [registration]
        }
        guard let credential = authorization.credential
            as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
            throw PasskeyError.platform("Unexpected credential type")
        }
        guard let attestation = credential.rawAttestationObject, !attestation.isEmpty else {
            throw PasskeyError.missingAttestation
        }
        return PasskeyRegistrationResult(
            credentialID: credential.credentialID,
            clientDataJSON: credential.rawClientDataJSON,
            attestationObject: attestation
        )
    }

    func authenticate(_ request: PasskeyAssertionRequest) async throws -> PasskeyAssertionResult {
        let authorization = try await PasskeyCeremony.perform {
            let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
                relyingPartyIdentifier: request.relyingPartyID
            )
            let assertion = provider.createCredentialAssertionRequest(challenge: request.challenge)
            assertion.userVerificationPreference = .required
            // Restrict the sheet to this hub's passkeys: every hub shares the
            // RP ID, so an empty list would offer all of them.
            assertion.allowedCredentials = request.allowedCredentialIDs.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
            // Web-created resident credentials may live on a roaming security
            // key rather than iCloud. Offer both providers for the same Hub.
            let securityKey = ASAuthorizationSecurityKeyPublicKeyCredentialProvider(
                relyingPartyIdentifier: request.relyingPartyID
            ).createCredentialAssertionRequest(challenge: request.challenge)
            securityKey.userVerificationPreference = .required
            securityKey.allowedCredentials = request.allowedCredentialIDs.map {
                ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor(
                    credentialID: $0, transports: [.usb, .nfc, .bluetooth]
                )
            }
            return [assertion, securityKey]
        }
        if let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            return PasskeyAssertionResult(
                credentialID: credential.credentialID, clientDataJSON: credential.rawClientDataJSON,
                authenticatorData: credential.rawAuthenticatorData, signature: credential.signature,
                userID: credential.userID
            )
        }
        if let credential = authorization.credential as? ASAuthorizationSecurityKeyPublicKeyCredentialAssertion {
            return PasskeyAssertionResult(
                credentialID: credential.credentialID, clientDataJSON: credential.rawClientDataJSON,
                authenticatorData: credential.rawAuthenticatorData, signature: credential.signature,
                userID: credential.userID, authenticatorAttachment: "cross-platform"
            )
        }
        throw PasskeyError.platform("Unexpected credential type")
    }
}

/// One `ASAuthorizationController` run bridged to async/await. Kept alive in
/// ``inFlight`` until the delegate fires (the controller holds its delegate
/// weakly).
@MainActor
private final class PasskeyCeremony: NSObject,
    ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    private static var inFlight: Set<PasskeyCeremony> = []

    private var continuation: CheckedContinuation<ASAuthorization, Error>?
    private var controller: ASAuthorizationController?

    static func perform(
        _ makeRequest: @MainActor () -> [ASAuthorizationRequest]
    ) async throws -> ASAuthorization {
        let ceremony = PasskeyCeremony()
        let request = makeRequest()
        return try await withCheckedThrowingContinuation { continuation in
            ceremony.start(request, continuation: continuation)
        }
    }

    private func start(_ request: [ASAuthorizationRequest], continuation: CheckedContinuation<ASAuthorization, Error>) {
        self.continuation = continuation
        let controller = ASAuthorizationController(authorizationRequests: request)
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller
        Self.inFlight.insert(self)
        controller.performRequests()
    }

    private func finish(_ result: Result<ASAuthorization, Error>) {
        continuation?.resume(with: result)
        continuation = nil
        controller = nil
        Self.inFlight.remove(self)
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        finish(.success(authorization))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        if let authorizationError = error as? ASAuthorizationError, authorizationError.code == .canceled {
            finish(.failure(PasskeyError.canceled))
        } else {
            finish(.failure(PasskeyError.platform(error.localizedDescription)))
        }
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        if let window = scene?.keyWindow ?? scene?.windows.first {
            return window
        }
        if let scene {
            return UIWindow(windowScene: scene)
        }
        return ASPresentationAnchor()
    }
}
