import Foundation
import NetworkExtension
import ObjectiveC.runtime

final class PacketTunnelProvider: NEPacketTunnelProvider {
    private let logPrefix = "packet-tunnel"
    private var currentConfigJSON: String = "{}"

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        let rawConfig = options?["configJSON"] as? String ?? "{}"
        guard let tunFD = extractTUNFD(), tunFD > 0 else {
            completionHandler(makeError("无法获取 TUN 文件描述符"))
            return
        }
        guard let configJSON = makeRuntimeConfig(rawConfig: rawConfig, tunFD: tunFD) else {
            completionHandler(makeError("VPN 配置格式无效"))
            return
        }
        currentConfigJSON = configJSON

        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "198.18.0.1")
        let ipv4 = NEIPv4Settings(addresses: ["198.18.0.2"], subnetMasks: ["255.255.255.0"])
        ipv4.includedRoutes = [NEIPv4Route.default()]
        settings.ipv4Settings = ipv4
        settings.dnsSettings = NEDNSSettings(servers: ["1.1.1.1", "8.8.8.8"])

        setTunnelNetworkSettings(settings) { [weak self] error in
            guard let self else {
                completionHandler(nil)
                return
            }
            if let error {
                completionHandler(error)
                return
            }
            if let started = self.invokeBridgeMethod(candidates: ["StartWithConfig", "startWithConfig"], arg: configJSON) {
                if self.bridgeOK(from: started) {
                    completionHandler(nil)
                    return
                }
                completionHandler(self.makeError("Go 数据面启动失败"))
                return
            }
            completionHandler(self.makeError("Go bridge 不可用"))
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        _ = invokeBridgeMethod(candidates: ["Offline", "offline"], arg: currentConfigJSON)
        _ = invokeBridgeNoArgMethod(candidates: ["Stop", "stop"])
        completionHandler()
    }

    private func bridgeOK(from payload: String) -> Bool {
        guard let data = payload.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        return (obj["ok"] as? Bool) ?? false
    }

    private func makeError(_ message: String) -> NSError {
        NSError(domain: logPrefix, code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func extractTUNFD() -> Int? {
        if let fd32 = packetFlow.value(forKeyPath: "socket.fileDescriptor") as? Int32 {
            return Int(fd32)
        }
        if let fd = packetFlow.value(forKeyPath: "socket.fileDescriptor") as? Int {
            return fd
        }
        return nil
    }

    private func makeRuntimeConfig(rawConfig: String, tunFD: Int) -> String? {
        guard var obj = (try? JSONSerialization.jsonObject(with: Data(rawConfig.utf8), options: [])) as? [String: Any] else {
            return nil
        }
        obj["tunFd"] = tunFD
        if obj["proxy"] == nil {
            obj["proxy"] = "socks5://127.0.0.1:1080"
        }
        guard let out = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let text = String(data: out, encoding: .utf8) else {
            return nil
        }
        return text
    }

    private func invokeBridgeMethod(candidates: [String], arg: String) -> String? {
        for className in ["Tunbridge", "TunbridgeTunbridge", "tunbridge.Tunbridge", "go.tunbridge.Tunbridge"] {
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

    private func invokeBridgeNoArgMethod(candidates: [String]) -> Bool {
        for className in ["Tunbridge", "TunbridgeTunbridge", "tunbridge.Tunbridge", "go.tunbridge.Tunbridge"] {
            guard let cls = NSClassFromString(className) else {
                continue
            }
            for method in candidates {
                if callClassNoArgMethod(cls: cls, methodName: method) {
                    return true
                }
            }
        }
        return false
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

    private func callClassNoArgMethod(cls: AnyClass, methodName: String) -> Bool {
        let selector = NSSelectorFromString(methodName)
        guard let method = class_getClassMethod(cls, selector) else {
            return false
        }
        typealias Function = @convention(c) (AnyClass, Selector) -> Void
        let implementation = method_getImplementation(method)
        let function = unsafeBitCast(implementation, to: Function.self)
        function(cls, selector)
        return true
    }
}
