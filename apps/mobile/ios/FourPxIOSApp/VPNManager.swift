import Foundation
import NetworkExtension

final class VPNManager {
    static let shared = VPNManager()
    private let tunnelBundleID = "com.fourpx.ios.PacketTunnel"
    private var managerCache: NETunnelProviderManager?

    private init() {}

    func start(config: AppConfig) async throws {
        let manager = try await ensureManager()
        let providerProtocol = NETunnelProviderProtocol()
        providerProtocol.providerBundleIdentifier = tunnelBundleID
        providerProtocol.serverAddress = "\(config.host):\(config.port)"
        providerProtocol.disconnectOnSleep = false
        manager.localizedDescription = "4px"
        manager.protocolConfiguration = providerProtocol
        manager.isEnabled = true
        try await save(manager)
        try await load(manager)
        let options: [String: NSObject] = [
            "configJSON": TunbridgeClient.shared.buildConfigJSON(config: config) as NSString
        ]
        try manager.connection.startVPNTunnel(options: options)
    }

    func stop() async throws {
        guard let manager = try await fetchManager() else {
            return
        }
        manager.connection.stopVPNTunnel()
    }

    private func ensureManager() async throws -> NETunnelProviderManager {
        if let cached = managerCache {
            return cached
        }
        if let existing = try await fetchManager() {
            managerCache = existing
            return existing
        }
        let created = NETunnelProviderManager()
        managerCache = created
        return created
    }

    private func fetchManager() async throws -> NETunnelProviderManager? {
        try await withCheckedThrowingContinuation { continuation in
            NETunnelProviderManager.loadAllFromPreferences { managers, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: managers?.first)
            }
        }
    }

    private func save(_ manager: NETunnelProviderManager) async throws {
        try await withCheckedThrowingContinuation { continuation in
            manager.saveToPreferences { error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: ())
            }
        }
    }

    private func load(_ manager: NETunnelProviderManager) async throws {
        try await withCheckedThrowingContinuation { continuation in
            manager.loadFromPreferences { error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: ())
            }
        }
    }
}
