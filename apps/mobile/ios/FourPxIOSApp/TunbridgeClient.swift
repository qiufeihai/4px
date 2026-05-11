import Foundation
import ObjectiveC.runtime

final class TunbridgeClient {
    static let shared = TunbridgeClient()

    private let bridgeClassCandidates = [
        "Tunbridge",
        "TunbridgeTunbridge",
        "tunbridge.Tunbridge",
        "go.tunbridge.Tunbridge"
    ]

    private init() {}

    func connectProbe(config: AppConfig) -> BridgeResult {
        let payload = buildConfigJSON(config: config)
        guard let raw = invokeJSON(candidates: ["ConnectProbe", "connectProbe"], arg: payload) else {
            return BridgeResult(ok: false, error: "go bridge not available", nextDeviceTicket: "")
        }
        return decodeBridgeResult(raw)
    }

    func offline(config: AppConfig) -> BridgeResult {
        let payload = buildConfigJSON(config: config)
        guard let raw = invokeJSON(candidates: ["Offline", "offline"], arg: payload) else {
            return BridgeResult(ok: false, error: "go bridge not available", nextDeviceTicket: "")
        }
        return decodeBridgeResult(raw)
    }

    func sessionStatus(config: AppConfig) -> SessionStatusResult {
        let payload = buildConfigJSON(config: config)
        guard let raw = invokeJSON(candidates: ["SessionStatus", "sessionStatus"], arg: payload) else {
            return SessionStatusResult(ok: false, error: "go bridge not available", expireAt: "", remainingDays: -1, expired: false)
        }
        return decodeSessionStatus(raw)
    }

    func localizeError(_ raw: String) -> String {
        let message = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if message.isEmpty {
            return "未知错误"
        }
        let lower = message.lowercased()
        let authReason = extractAuthReason(from: lower)
        if lower.contains("go bridge not available") {
            return "Go 运行库未加载，请先生成并接入 tun2socks.xcframework"
        }
        if lower.contains("hostname") && lower.contains("not verified") {
            return "证书域名校验失败，请使用证书匹配的域名"
        }
        if lower.contains("certificate") || lower.contains("x509") {
            return "证书校验失败"
        }
        if lower.contains("no such host") {
            return "域名解析失败"
        }
        if lower.contains("timeout") {
            return "连接超时"
        }
        if lower.contains("connection refused") {
            return "连接被拒绝"
        }
        if lower.contains("status=401") {
            if authReason.contains("expired") {
                return "令牌已过期"
            }
            return "授权失败，请检查令牌"
        }
        if lower.contains("status=403") {
            if authReason.contains("device") {
                return "设备数已达上限"
            }
            return "访问被拒绝"
        }
        if lower.contains("status=429") {
            return "请求过于频繁，请稍后重试"
        }
        if lower.contains("status=5") {
            return "服务端异常，请稍后重试"
        }
        return message
    }

    func buildConfigJSON(config: AppConfig) -> String {
        let payload: [String: Any] = [
            "upstreamHost": config.host,
            "upstreamPort": config.port,
            "authToken": config.authToken,
            "deviceTicket": config.deviceTicket,
            "rejectUnauthorized": true,
            "serverName": config.host,
            "socksListen": "127.0.0.1:1080"
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }

    private func decodeBridgeResult(_ raw: String) -> BridgeResult {
        guard let data = raw.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(BridgeResult.self, from: data) else {
            return BridgeResult(ok: false, error: "bridge result decode failed", nextDeviceTicket: "")
        }
        return parsed
    }

    private func decodeSessionStatus(_ raw: String) -> SessionStatusResult {
        guard let data = raw.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(SessionStatusResult.self, from: data) else {
            return SessionStatusResult(ok: false, error: "session status decode failed", expireAt: "", remainingDays: -1, expired: false)
        }
        return parsed
    }

    private func extractAuthReason(from lowerMessage: String) -> String {
        guard let range = lowerMessage.range(of: "auth_reason=") else {
            return ""
        }
        let tail = lowerMessage[range.upperBound...]
        if let end = tail.firstIndex(where: { $0 == " " || $0 == "," }) {
            return String(tail[..<end])
        }
        return String(tail)
    }

    private func invokeJSON(candidates: [String], arg: String) -> String? {
        for className in bridgeClassCandidates {
            guard let cls = NSClassFromString(className) else {
                continue
            }
            for method in candidates {
                if let text = callClassMethod(cls: cls, methodName: method, arg: arg) {
                    return text
                }
            }
        }
        return nil
    }

    private func callClassMethod(cls: AnyClass, methodName: String, arg: String) -> String? {
        let selector = NSSelectorFromString("\(methodName):")
        guard let method = class_getClassMethod(cls, selector) else {
            return nil
        }
        typealias Function = @convention(c) (AnyClass, Selector, NSString) -> Unmanaged<AnyObject>?
        let implementation = method_getImplementation(method)
        let function = unsafeBitCast(implementation, to: Function.self)
        let result = function(cls, selector, arg as NSString)?.takeUnretainedValue()
        return result as? String
    }
}
