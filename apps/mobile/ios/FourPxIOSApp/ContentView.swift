import SwiftUI

struct ContentView: View {
    @StateObject private var vm = MainViewModel()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    Text("4px")
                        .font(.title2.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Group {
                        LabeledField(title: "服务地址", placeholder: "例如 zyko2.online", text: $vm.host)
                        LabeledField(title: "端口", placeholder: "6666", text: $vm.port, keyboard: .numberPad)
                        LabeledField(title: "授权令牌", placeholder: "请输入 auth token", text: $vm.token)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text(vm.statusText)
                            .font(.subheadline)
                            .foregroundStyle(vm.statusIsError ? .red : .secondary)
                        Text(vm.expiryText)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 10) {
                        Button("连接") { vm.connect() }
                            .buttonStyle(.borderedProminent)
                            .disabled(vm.busy)
                        Button("断开") { vm.disconnect() }
                            .buttonStyle(.bordered)
                            .disabled(vm.busy)
                    }

                    HStack(spacing: 10) {
                        Button("刷新有效期") { vm.refreshExpiry(silent: false) }
                            .buttonStyle(.bordered)
                            .disabled(vm.busy)
                        Button("查看日志") { vm.showLogs = true }
                            .buttonStyle(.bordered)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(16)
            }
            .navigationBarTitleDisplayMode(.inline)
            .task {
                vm.load()
                vm.refreshExpiry(silent: true)
            }
            .sheet(isPresented: $vm.showLogs) {
                LogsView(text: vm.logsText, onClear: vm.clearLogs)
            }
            .overlay(alignment: .center) {
                if vm.busy {
                    ProgressView()
                        .progressViewStyle(.circular)
                }
            }
        }
    }
}

private struct LabeledField: View {
    let title: String
    let placeholder: String
    @Binding var text: String
    var keyboard: UIKeyboardType = .default

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline)
            TextField(placeholder, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(keyboard)
                .padding(10)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }
}

private struct LogsView: View {
    let text: String
    let onClear: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(text.isEmpty ? "暂无日志" : text)
                    .font(.system(size: 12, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .navigationTitle("运行日志")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("清空") { onClear() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }
}

@MainActor
final class MainViewModel: ObservableObject {
    @Published var host: String = ""
    @Published var port: String = "6666"
    @Published var token: String = ""
    @Published var statusText: String = "状态：未连接"
    @Published var statusIsError: Bool = false
    @Published var expiryText: String = "有效期：未查询"
    @Published var busy: Bool = false
    @Published var showLogs: Bool = false

    private let configStore = ConfigStore()
    private let bridge = TunbridgeClient.shared
    private let vpnManager = VPNManager.shared

    var logsText: String { AppLog.shared.dump() }

    func load() {
        let config = configStore.load()
        host = config.host
        port = String(config.port)
        token = config.authToken
    }

    func clearLogs() {
        AppLog.shared.clear()
    }

    func connect() {
        guard let config = validatedConfig() else { return }
        busy = true
        statusIsError = false
        statusText = "状态：连接中"
        AppLog.shared.info("ios", "start connect host=\(config.host) port=\(config.port)")
        Task {
            let result = bridge.connectProbe(config: config)
            guard result.ok else {
                busy = false
                let localized = bridge.localizeError(result.error)
                statusText = "状态：错误 - \(localized)"
                statusIsError = true
                AppLog.shared.error("ios", "connect failed raw=\(result.error)")
                return
            }
            var updated = config
            if !result.nextDeviceTicket.trimmingCharacters(in: .whitespaces).isEmpty {
                updated.deviceTicket = result.nextDeviceTicket
            }
            configStore.save(updated)
            do {
                try await vpnManager.start(config: updated)
                busy = false
                statusText = "状态：VPN 已启动"
                statusIsError = false
                AppLog.shared.info("ios", "vpn started")
                refreshExpiry(silent: true)
            } catch {
                busy = false
                let localized = localizeVPNError(error)
                statusText = "状态：错误 - \(localized)"
                statusIsError = true
                AppLog.shared.error("ios", "vpn start failed error=\(error.localizedDescription)")
                _ = bridge.offline(config: updated)
            }
        }
    }

    func disconnect() {
        guard let config = validatedConfig() else { return }
        busy = true
        statusIsError = false
        statusText = "状态：断开中"
        AppLog.shared.info("ios", "start disconnect")
        Task {
            do {
                try await vpnManager.stop()
            } catch {
                AppLog.shared.error("ios", "vpn stop warning error=\(error.localizedDescription)")
            }
            let result = bridge.offline(config: config)
            busy = false
            if result.ok {
                var updated = config
                if !result.nextDeviceTicket.trimmingCharacters(in: .whitespaces).isEmpty {
                    updated.deviceTicket = result.nextDeviceTicket
                }
                configStore.save(updated)
                statusText = "状态：已断开"
                statusIsError = false
                AppLog.shared.info("ios", "disconnect success")
            } else {
                let localized = bridge.localizeError(result.error)
                statusText = "状态：错误 - \(localized)"
                statusIsError = true
                AppLog.shared.error("ios", "disconnect failed raw=\(result.error)")
            }
        }
    }

    private func localizeVPNError(_ error: Error) -> String {
        let text = error.localizedDescription.lowercased()
        if text.contains("permission") || text.contains("entitlement") {
            return "VPN 权限不可用，请检查签名与 NetworkExtension 配置"
        }
        if text.contains("configuration") || text.contains("preference") {
            return "VPN 配置保存失败，请稍后重试"
        }
        return "VPN 启动失败：\(error.localizedDescription)"
    }

    func refreshExpiry(silent: Bool) {
        guard let config = validatedConfigForQuery() else {
            expiryText = "有效期：未查询"
            return
        }
        AppLog.shared.info("ios", "refresh expiry")
        Task {
            let result = bridge.sessionStatus(config: config)
            if !result.ok {
                let localized = bridge.localizeError(result.error)
                expiryText = "有效期：查询失败（\(localized)）"
                if !silent {
                    statusText = "状态：错误 - \(localized)"
                    statusIsError = true
                }
                return
            }
            expiryText = formatExpiry(result)
        }
    }

    private func validatedConfig() -> AppConfig? {
        let h = host.trimmingCharacters(in: .whitespacesAndNewlines)
        if h.isEmpty {
            statusText = "状态：错误 - 服务地址不能为空"
            statusIsError = true
            return nil
        }
        guard let p = Int(port), (1...65535).contains(p) else {
            statusText = "状态：错误 - 端口不合法"
            statusIsError = true
            return nil
        }
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty {
            statusText = "状态：错误 - 令牌不能为空"
            statusIsError = true
            return nil
        }
        var cfg = configStore.load()
        cfg.host = h
        cfg.port = p
        cfg.authToken = t
        configStore.save(cfg)
        return cfg
    }

    private func validatedConfigForQuery() -> AppConfig? {
        let h = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !h.isEmpty, let p = Int(port), (1...65535).contains(p), !t.isEmpty else {
            return nil
        }
        var cfg = configStore.load()
        cfg.host = h
        cfg.port = p
        cfg.authToken = t
        configStore.save(cfg)
        return cfg
    }

    private func formatExpiry(_ result: SessionStatusResult) -> String {
        if result.remainingDays < 0 || result.expireAt.isEmpty {
            return "有效期：长期有效"
        }
        if result.expired || result.remainingDays <= 0 {
            return "有效期：已过期"
        }
        if result.remainingDays == 1 {
            return "有效期：不足 24 小时（到期：\(result.expireAt)）"
        }
        return "有效期：剩余 \(result.remainingDays) 天（到期：\(result.expireAt)）"
    }
}
