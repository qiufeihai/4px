import Foundation

final class ConfigStore {
    private let key = "fourpx.ios.app.config.v1"
    private let defaults = UserDefaults.standard

    func load() -> AppConfig {
        guard let raw = defaults.data(forKey: key) else {
            return .default
        }
        do {
            return try JSONDecoder().decode(AppConfig.self, from: raw)
        } catch {
            return .default
        }
    }

    func save(_ config: AppConfig) {
        guard let raw = try? JSONEncoder().encode(config) else {
            return
        }
        defaults.set(raw, forKey: key)
    }
}
