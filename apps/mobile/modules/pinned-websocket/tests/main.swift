// Run without a simulator: swiftc ios/PinnedSocket.swift tests/main.swift -o /tmp/sb-pin-test && /tmp/sb-pin-test
import Foundation

final class ChallengeSender: NSObject, URLAuthenticationChallengeSender {
  func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) {}
  func continueWithoutCredential(for challenge: URLAuthenticationChallenge) {}
  func cancel(_ challenge: URLAuthenticationChallenge) {}
}

var events: [[String: Any]] = []
let socket = PinnedSocket(url: URL(string: "wss://localhost")!, fingerprint: String(repeating: "a", count: 64)) {
  events.append($0)
}
let challenge = URLAuthenticationChallenge(
  protectionSpace: URLProtectionSpace(host: "localhost", port: 443, protocol: "https", realm: nil,
                                      authenticationMethod: NSURLAuthenticationMethodHTTPBasic),
  proposedCredential: nil, previousFailureCount: 0, failureResponse: nil, error: nil, sender: ChallengeSender())
var defaultHandled = false
socket.urlSession(URLSession.shared, didReceive: challenge) { disposition, credential in
  defaultHandled = disposition == .performDefaultHandling && credential == nil
}
guard defaultHandled, events.isEmpty else {
  print("FAIL: Non-server-trust challenges must use default handling without a certificate-change event")
  exit(1)
}
print("Non-server-trust challenge: passed")

let untrusted = URLAuthenticationChallenge(
  protectionSpace: URLProtectionSpace(host: "localhost", port: 443, protocol: "https", realm: nil,
                                      authenticationMethod: NSURLAuthenticationMethodServerTrust),
  proposedCredential: nil, previousFailureCount: 0, failureResponse: nil, error: nil, sender: ChallengeSender())
var cancelled = false
socket.urlSession(URLSession.shared, didReceive: untrusted) { disposition, credential in
  cancelled = disposition == .cancelAuthenticationChallenge && credential == nil
}
guard cancelled, events.count == 1, events[0]["certificateChanged"] as? Bool == false else {
  print("FAIL: Server trust without a leaf certificate must cancel with an ordinary TLS failure")
  exit(1)
}
print("Missing server trust: passed")
