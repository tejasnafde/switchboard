import CryptoKit
import Foundation
import Security
import os

private let log = Logger(subsystem: "app.switchboard.mobile", category: "transport:pinned-websocket")

final class PinnedSocket: NSObject, URLSessionWebSocketDelegate {
  private let url: URL
  private let fingerprint: String
  private let emit: ([String: Any]) -> Void
  private var session: URLSession!
  private var task: URLSessionWebSocketTask!
  private var finished = false
  private var verified = false

  init(url: URL, fingerprint: String, emit: @escaping ([String: Any]) -> Void) {
    self.url = url
    self.fingerprint = fingerprint
    self.emit = emit
  }

  func start() {
    // One ephemeral session per socket prevents pooled trust or TLS session reuse across pins.
    session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: .main)
    task = session.webSocketTask(with: url)
    // Match WsHost.MAX_FRAME_BYTES so image-bearing history is not truncated at URLSession's default.
    task.maximumMessageSize = 64 * 1024 * 1024
    task.resume()
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    guard !finished, let trust = challenge.protectionSpace.serverTrust,
          let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
          let leaf = certificates.first else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      fail()
      return
    }
    let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
      .map { String(format: "%02x", $0) }.joined()
    guard digest == fingerprint else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      fail(certificateChanged: true)
      return
    }
    verified = true
    // The QR pin is the trust anchor. Deliberately no CA or hostname fallback.
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    guard !finished else { return }
    guard verified else { fail(); return }
    emit(["type": "open"])
    receive()
  }

  private func receive() {
    task.receive { [weak self] result in
      DispatchQueue.main.async {
        guard let self, !self.finished else { return }
        switch result {
        case .success(.string(let text)):
          self.emit(["type": "message", "data": text])
          self.receive()
        case .success(.data(let data)):
          guard let text = String(data: data, encoding: .utf8) else { self.fail(); return }
          self.emit(["type": "message", "data": text])
          self.receive()
        case .success:
          self.fail()
        case .failure:
          self.fail()
        }
      }
    }
  }

  func send(_ text: String) {
    guard !finished else { return }
    task.send(.string(text)) { [weak self] error in
      if error != nil { DispatchQueue.main.async { self?.fail() } }
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                  didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    finish(["type": "close", "code": closeCode.rawValue])
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if !finished { fail() }
  }

  private func fail(certificateChanged: Bool = false) {
    guard !finished else { return }
    log.warning("Pinned socket failed, certificateChanged: \(certificateChanged)")
    finish(["type": "error", "certificateChanged": certificateChanged])
  }

  private func finish(_ event: [String: Any]) {
    guard !finished else { return }
    finished = true
    task?.cancel(with: .goingAway, reason: nil)
    session?.invalidateAndCancel()
    emit(event)
  }

  func close() { finish(["type": "close", "code": 1000]) }
}
