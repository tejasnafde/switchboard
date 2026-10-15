import ExpoModulesCore
import Foundation
import os

private let log = Logger(subsystem: "app.switchboard.mobile", category: "transport:pinned-websocket")

public final class SwitchboardPinnedWebSocketModule: Module {
  private var sockets: [String: PinnedSocket] = [:]

  public func definition() -> ModuleDefinition {
    Name("SwitchboardPinnedWebSocket")
    Events("socketEvent")

    Function("connect") { (id: String, address: String, fingerprint: String) in
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        guard let url = URL(string: address), url.scheme == "wss",
              fingerprint.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              self.sockets[id] == nil else {
          log.error("Invalid pinned socket target")
          self.sendEvent("socketEvent", ["id": id, "type": "error"])
          return
        }
        let socket = PinnedSocket(url: url, fingerprint: fingerprint) { [weak self] event in
          guard let self else { return }
          if event["type"] as? String == "close" || event["type"] as? String == "error" {
            self.sockets.removeValue(forKey: id)
          }
          self.sendEvent("socketEvent", event.merging(["id": id]) { _, new in new })
        }
        self.sockets[id] = socket
        socket.start()
      }
    }
    Function("send") { (id: String, text: String) in
      DispatchQueue.main.async { [weak self] in self?.sockets[id]?.send(text) }
    }
    Function("close") { (id: String) in
      DispatchQueue.main.async { [weak self] in self?.sockets.removeValue(forKey: id)?.close() }
    }
    OnDestroy { [weak self] in
      guard let self else { return }
      DispatchQueue.main.async {
        let sockets = Array(self.sockets.values)
        self.sockets.removeAll()
        for socket in sockets { socket.close() }
      }
    }
  }
}
