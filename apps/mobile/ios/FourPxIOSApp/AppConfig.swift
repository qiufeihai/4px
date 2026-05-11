import Foundation

struct AppConfig: Codable {
    var host: String
    var port: Int
    var authToken: String
    var deviceTicket: String

    static let `default` = AppConfig(
        host: "",
        port: 6666,
        authToken: "",
        deviceTicket: ""
    )
}

struct BridgeResult: Codable {
    var ok: Bool
    var error: String
    var nextDeviceTicket: String
}

struct SessionStatusResult: Codable {
    var ok: Bool
    var error: String
    var expireAt: String
    var remainingDays: Int
    var expired: Bool
}
