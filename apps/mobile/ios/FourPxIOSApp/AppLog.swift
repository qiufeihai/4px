import Foundation

final class AppLog {
    static let shared = AppLog()
    private let maxLines = 200
    private let lock = NSLock()
    private var lines: [String] = []

    private init() {}

    func info(_ tag: String, _ msg: String) {
        add("I", tag, msg)
    }

    func error(_ tag: String, _ msg: String) {
        add("E", tag, msg)
    }

    func dump() -> String {
        lock.lock()
        defer { lock.unlock() }
        return lines.joined(separator: "\n")
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        lines.removeAll(keepingCapacity: true)
    }

    private func add(_ level: String, _ tag: String, _ msg: String) {
        let ts = Self.timeString()
        lock.lock()
        defer { lock.unlock() }
        lines.append("\(ts) \(level)/\(tag) \(msg)")
        if lines.count > maxLines {
            lines.removeFirst(lines.count - maxLines)
        }
    }

    private static func timeString() -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss"
        return fmt.string(from: Date())
    }
}
