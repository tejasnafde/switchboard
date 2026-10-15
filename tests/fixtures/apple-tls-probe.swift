// URLSession exercises Apple's TLS parser before the certificate pin callback.
import Foundation
import Security
import CryptoKit

final class Probe: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    let pin: String
    let done = DispatchSemaphore(value: 0)
    var accepted = false
    var rejected = false
    var echoed = false

    init(_ pin: String) { self.pin = pin }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let trust = challenge.protectionSpace.serverTrust,
              let cert = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else {
            print("NO TRUST")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let actual = SHA256.hash(data: SecCertificateCopyData(cert) as Data)
            .map { String(format: "%02x", $0) }.joined()
        accepted = actual == pin
        rejected = actual != pin
        print("TRUST CALLBACK match=\(accepted)")
        completionHandler(
            accepted ? .useCredential : .cancelAuthenticationChallenge,
            accepted ? URLCredential(trust: trust) : nil
        )
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        print("OPEN")
    }
}

let probe = Probe(CommandLine.arguments[2])
let config = URLSessionConfiguration.ephemeral
config.timeoutIntervalForRequest = 8
if CommandLine.arguments.contains("tls12") {
    config.tlsMaximumSupportedProtocolVersion = .TLSv12
}
let session = URLSession(configuration: config, delegate: probe, delegateQueue: nil)
let task = session.webSocketTask(with: URL(string: CommandLine.arguments[1])!)
task.resume()
Task {
    do {
        try await task.send(.string("hello"))
        switch try await task.receive() {
        case .string(let text): probe.echoed = text == "hello"
        case .data(let data): probe.echoed = data == Data("hello".utf8)
        @unknown default: probe.echoed = false
        }
        print("ECHO match=\(probe.echoed)")
    } catch {
        print("FAIL \(error)")
    }
    probe.done.signal()
}
if probe.done.wait(timeout: .now() + 12) == .timedOut {
    print("TIMEOUT")
    exit(1)
}
task.cancel(with: .normalClosure, reason: nil)
session.invalidateAndCancel()
let expectedMismatch = CommandLine.arguments.contains("mismatch")
exit(expectedMismatch ? (probe.rejected && !probe.echoed ? 0 : 1) : (probe.accepted && probe.echoed ? 0 : 1))
