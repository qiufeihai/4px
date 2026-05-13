package com.fourpx.mobile

import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AlertDialog
import androidx.activity.result.contract.ActivityResultContracts
import com.google.android.material.textfield.TextInputEditText
import org.json.JSONObject
import java.lang.reflect.Method
import java.net.Inet4Address
import java.net.InetAddress
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var hostInput: TextInputEditText
    private lateinit var portInput: TextInputEditText
    private lateinit var tokenInput: TextInputEditText
    private lateinit var connectButton: Button
    private lateinit var disconnectButton: Button
    private lateinit var logsButton: Button
    private lateinit var refreshExpiryButton: Button
    private lateinit var loadingBar: ProgressBar
    private lateinit var statusText: TextView
    private lateinit var expiryText: TextView

    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private lateinit var configStore: ConfigStore
    private var pendingVpnConfig: AppConfig? = null
    private val vpnPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val config = pendingVpnConfig
        pendingVpnConfig = null
        if (result.resultCode != RESULT_OK || config == null) {
            showError(getString(R.string.error_vpn_permission_denied))
            setState(UiState.IDLE)
            return@registerForActivityResult
        }
        doConnect(config)
    }

    private enum class UiState {
        IDLE,
        CONNECTING,
        CONNECTED,
        DISCONNECTING
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        bindViews()
        configStore = ConfigStore(this)
        renderConfig(configStore.load())
        setState(UiState.IDLE)
        bindActions()
        refreshExpiryStatus(configStore.load(), silent = true)
    }

    override fun onDestroy() {
        ioExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun bindViews() {
        hostInput = findViewById(R.id.hostInput)
        portInput = findViewById(R.id.portInput)
        tokenInput = findViewById(R.id.tokenInput)
        connectButton = findViewById(R.id.connectButton)
        disconnectButton = findViewById(R.id.disconnectButton)
        logsButton = findViewById(R.id.logsButton)
        refreshExpiryButton = findViewById(R.id.refreshExpiryButton)
        loadingBar = findViewById(R.id.loadingBar)
        statusText = findViewById(R.id.statusText)
        expiryText = findViewById(R.id.expiryText)
    }

    private fun bindActions() {
        connectButton.setOnClickListener {
            val cfg = readConfigFromInputs() ?: return@setOnClickListener
            configStore.save(cfg)
            requestVpnPermissionThenConnect(cfg)
        }
        disconnectButton.setOnClickListener {
            val cfg = readConfigFromInputs() ?: return@setOnClickListener
            configStore.save(cfg)
            doDisconnect(cfg)
        }
        logsButton.setOnClickListener {
            showLogsDialog()
        }
        refreshExpiryButton.setOnClickListener {
            val cfg = readConfigFromInputs() ?: return@setOnClickListener
            refreshExpiryStatus(cfg, silent = false)
        }
    }

    private fun readConfigFromInputs(): AppConfig? {
        val storedConfig = configStore.load()
        val host = hostInput.text?.toString()?.trim().orEmpty()
        if (host.isEmpty()) {
            showError(getString(R.string.error_invalid_host))
            return null
        }
        val port = portInput.text?.toString()?.trim()?.toIntOrNull() ?: -1
        if (port !in 1..65535) {
            showError(getString(R.string.error_invalid_port))
            return null
        }
        val token = tokenInput.text?.toString()?.trim().orEmpty()
        if (token.isEmpty()) {
            showError(getString(R.string.error_invalid_token))
            return null
        }
        return AppConfig(
            host = host,
            port = port,
            authToken = token,
            deviceId = storedConfig.deviceId,
            deviceTicket = storedConfig.deviceTicket
        )
    }

    private fun renderConfig(config: AppConfig) {
        hostInput.setText(config.host)
        portInput.setText(config.port.toString())
        tokenInput.setText(config.authToken)
    }

    private fun doConnect(config: AppConfig) {
        AppLog.i("main", "start connect host=${config.host} port=${config.port}")
        setState(UiState.CONNECTING)
        ioExecutor.execute {
            val result = connectViaGoBridge(config)
            runOnUiThread {
                if (!result.ok) {
                    showError(result.error)
                    setState(UiState.IDLE)
                    return@runOnUiThread
                }
                val runningConfig = config.copy(
                    deviceTicket = if (result.nextDeviceTicket.isNotBlank()) {
                        result.nextDeviceTicket
                    } else {
                        config.deviceTicket
                    }
                )
                configStore.save(runningConfig)
                FourPxVpnService.start(
                    this,
                    tunbridgeConfigJson = buildTunbridgeConfigJson(runningConfig)
                )
                AppLog.i("main", "connect success ticket_updated=${runningConfig.deviceTicket.isNotBlank()}")
                statusText.text = getString(R.string.status_vpn_starting)
                refreshExpiryStatus(runningConfig, silent = true)
                setState(UiState.CONNECTED)
                verifyVpnDataPlaneAsync()
            }
        }
    }

    private fun doDisconnect(config: AppConfig) {
        AppLog.i("main", "start disconnect")
        setState(UiState.DISCONNECTING)
        ioExecutor.execute {
            val result = offlineViaGoBridge(config)
            runOnUiThread {
                if (!result.ok) {
                    showError(result.error)
                    setState(UiState.CONNECTED)
                    return@runOnUiThread
                }
                configStore.save(
                    config.copy(
                        deviceTicket = if (result.nextDeviceTicket.isNotBlank()) {
                            result.nextDeviceTicket
                        } else {
                            config.deviceTicket
                        }
                    )
                )
                FourPxVpnService.stop(this)
                AppLog.i("main", "disconnect success")
                statusText.text = getString(R.string.status_disconnected)
                setState(UiState.IDLE)
            }
        }
    }

    private fun requestVpnPermissionThenConnect(config: AppConfig) {
        val prepareIntent: Intent? = VpnService.prepare(this)
        if (prepareIntent == null) {
            doConnect(config)
            return
        }
        pendingVpnConfig = config
        statusText.text = getString(R.string.status_vpn_permission_required)
        vpnPermissionLauncher.launch(prepareIntent)
    }

    private fun showError(message: String) {
        val localized = localizeError(message)
        AppLog.e("main", "error raw=\"$message\" localized=\"$localized\"")
        statusText.text = getString(R.string.status_error, localized)
        Toast.makeText(this, localized, Toast.LENGTH_SHORT).show()
    }

    private fun showLogsDialog() {
        val logs = AppLog.dump().ifBlank { getString(R.string.logs_empty) }
        val versionText = "版本 ${appVersionName()}"
        AlertDialog.Builder(this)
            .setTitle(R.string.logs_title)
            .setMessage("$logs\n\n$versionText")
            .setPositiveButton(R.string.logs_close, null)
            .setNeutralButton(R.string.logs_clear) { _, _ ->
                AppLog.clear()
                Toast.makeText(this, getString(R.string.logs_cleared), Toast.LENGTH_SHORT).show()
            }
            .show()
    }

    private fun appVersionName(): String {
        val info = packageManager.getPackageInfo(packageName, 0)
        return info.versionName ?: "?"
    }

    private fun appVersionCode(): Long {
        val info = packageManager.getPackageInfo(packageName, 0)
        return info.longVersionCode
    }

    private fun buildTunbridgeConfigJson(config: AppConfig): String {
        val resolvedHost = resolvePreferredUpstreamHost(config.host)
        return JSONObject()
            .put("upstreamHost", resolvedHost)
            .put("upstreamPort", config.port)
            .put("authToken", config.authToken)
            .put("deviceId", config.deviceId)
            .put("deviceTicket", config.deviceTicket)
            .put("rejectUnauthorized", true)
            .put("serverName", config.host)
            .put("socksListen", "127.0.0.1:1080")
            .toString()
    }

    private fun refreshExpiryStatus(config: AppConfig, silent: Boolean) {
        AppLog.i("main", "refresh expiry status")
        ioExecutor.execute {
            val result = fetchSessionStatusViaGoBridge(config)
            runOnUiThread {
                if (!result.ok) {
                    val localized = localizeError(result.error)
                    expiryText.text = getString(R.string.expiry_failed, localized)
                    if (!silent) {
                        Toast.makeText(this, localized, Toast.LENGTH_SHORT).show()
                    }
                    return@runOnUiThread
                }
                expiryText.text = formatExpiryStatus(result)
            }
        }
    }

    private fun connectViaGoBridge(config: AppConfig): ApiResult {
        val cfgJson = buildTunbridgeConfigJson(config)
        val bridgeResult = invokeTunbridgeJsonMethod(
            candidates = listOf("ConnectProbe", "connectProbe"),
            arg = cfgJson
        )
        if (bridgeResult != null) {
            return bridgeResult
        }
        return ApiResult(false, "go bridge not available")
    }

    private fun offlineViaGoBridge(config: AppConfig): ApiResult {
        val cfgJson = buildTunbridgeConfigJson(config)
        val bridgeResult = invokeTunbridgeJsonMethod(
            candidates = listOf("Offline", "offline"),
            arg = cfgJson
        )
        if (bridgeResult != null) {
            return bridgeResult
        }
        return ApiResult(false, "go bridge not available")
    }

    private fun verifyVpnDataPlaneAsync() {
        ioExecutor.execute {
            try {
                Thread.sleep(1200)
            } catch (_: InterruptedException) {
                return@execute
            }
            val stats = fetchBridgeStatsViaGoBridge()
            runOnUiThread {
                if (stats.running) {
                    AppLog.i("main", "vpn data plane ready proxy=${stats.proxy} mtu=${stats.mtu} log=${stats.logLevel}")
                    statusText.text = getString(R.string.status_vpn_started)
                    return@runOnUiThread
                }
                val rawError = stats.lastError.ifBlank { getString(R.string.error_vpn_data_plane_not_ready) }
                AppLog.e("main", "vpn data plane not ready error=$rawError")
                showError(rawError)
                setState(UiState.IDLE)
            }
        }
    }

    private fun fetchSessionStatusViaGoBridge(config: AppConfig): SessionStatusResult {
        val cfgJson = buildTunbridgeConfigJson(config)
        val bridgePayload = invokeTunbridgeRawJsonMethod(
            candidates = listOf("SessionStatus", "sessionStatus"),
            arg = cfgJson
        ) ?: return SessionStatusResult(false, "go bridge not available")
        return parseSessionStatusResult(bridgePayload)
    }

    private fun fetchBridgeStatsViaGoBridge(): BridgeStatsResult {
        val payload = invokeTunbridgeRawNoArgMethod(
            candidates = listOf("GetStats", "getStats")
        ) ?: return BridgeStatsResult(
            running = false,
            lastError = "go bridge stats unavailable"
        )
        return try {
            val obj = JSONObject(payload)
            BridgeStatsResult(
                running = obj.optBoolean("running", false),
                lastError = obj.optString("lastError", "").trim(),
                proxy = obj.optString("proxy", "").trim(),
                mtu = obj.optInt("mtu", 0),
                logLevel = obj.optString("logLevel", "").trim()
            )
        } catch (err: Exception) {
            AppLog.e("main", "invalid bridge stats result: ${err.message}")
            BridgeStatsResult(
                running = false,
                lastError = err.message ?: "invalid bridge stats result"
            )
        }
    }

    private fun invokeTunbridgeJsonMethod(candidates: List<String>, arg: String): ApiResult? {
        val raw = invokeTunbridgeRawJsonMethod(candidates, arg) ?: return null
        return parseBridgeResult(raw)
    }

    private fun invokeTunbridgeRawJsonMethod(candidates: List<String>, arg: String): String? {
        val bridgeClasses = listOf("go.tunbridge.Tunbridge", "tunbridge.Tunbridge")
        for (className in bridgeClasses) {
            try {
                val cls = Class.forName(className)
                val method = resolveBridgeMethod(cls, candidates) ?: continue
                val ret = method.invoke(null, arg)
                if (ret !is String) {
                    AppLog.e("main", "bridge method ${method.name} in $className returned non-string")
                    return null
                }
                return ret
            } catch (_: ClassNotFoundException) {
                continue
            } catch (_: NoSuchMethodException) {
                continue
            } catch (err: Exception) {
                AppLog.e("main", "bridge call failed in $className: ${err.message}")
                return null
            }
        }
        return null
    }

    private fun invokeTunbridgeRawNoArgMethod(candidates: List<String>): String? {
        val bridgeClasses = listOf("go.tunbridge.Tunbridge", "tunbridge.Tunbridge")
        for (className in bridgeClasses) {
            try {
                val cls = Class.forName(className)
                val method = cls.methods.firstOrNull { m ->
                    candidates.contains(m.name) && m.parameterTypes.isEmpty()
                } ?: continue
                val ret = method.invoke(null)
                if (ret !is String) {
                    AppLog.e("main", "bridge method ${method.name} in $className returned non-string")
                    return null
                }
                return ret
            } catch (_: ClassNotFoundException) {
                continue
            } catch (_: NoSuchMethodException) {
                continue
            } catch (err: Exception) {
                AppLog.e("main", "bridge no-arg call failed in $className: ${err.message}")
                return null
            }
        }
        return null
    }

    private fun resolveBridgeMethod(cls: Class<*>, names: List<String>): Method? {
        return cls.methods.firstOrNull { m ->
            names.contains(m.name) &&
                m.parameterTypes.size == 1 &&
                m.parameterTypes[0] == String::class.java
        }
    }

    private fun parseBridgeResult(payload: String): ApiResult {
        return try {
            val obj = JSONObject(payload)
            ApiResult(
                ok = obj.optBoolean("ok", false),
                error = obj.optString("error", ""),
                nextDeviceTicket = obj.optString("nextDeviceTicket", "").trim()
            )
        } catch (err: Exception) {
            AppLog.e("main", "invalid bridge result: ${err.message}")
            ApiResult(false, err.message ?: "invalid bridge result")
        }
    }

    private fun parseSessionStatusResult(payload: String): SessionStatusResult {
        return try {
            val obj = JSONObject(payload)
            SessionStatusResult(
                ok = obj.optBoolean("ok", false),
                error = obj.optString("error", ""),
                expireAt = obj.optString("expireAt", "").trim(),
                remainingDays = obj.optInt("remainingDays", -1),
                expired = obj.optBoolean("expired", false)
            )
        } catch (err: Exception) {
            AppLog.e("main", "invalid session status result: ${err.message}")
            SessionStatusResult(false, err.message ?: "invalid session status result")
        }
    }

    private fun formatExpiryStatus(result: SessionStatusResult): String {
        if (!result.ok) {
            return getString(R.string.expiry_failed, localizeError(result.error))
        }
        if (result.remainingDays < 0 || result.expireAt.isBlank()) {
            return getString(R.string.expiry_unlimited)
        }
        if (result.expired || result.remainingDays <= 0) {
            return getString(R.string.expiry_expired)
        }
        if (result.remainingDays == 1) {
            return getString(R.string.expiry_less_than_one_day)
        }
        return getString(R.string.expiry_remaining_days, result.remainingDays, formatExpiryTime(result.expireAt))
    }

    private fun formatExpiryTime(raw: String): String {
        val value = raw.trim()
        if (value.isEmpty()) {
            return raw
        }
        return try {
            OffsetDateTime.parse(value)
                .atZoneSameInstant(ZoneId.systemDefault())
                .format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))
        } catch (_: Exception) {
            raw
        }
    }

    private fun resolvePreferredUpstreamHost(host: String): String {
        return try {
            val addrs = InetAddress.getAllByName(host)
            val ipv4 = addrs.firstOrNull { it is Inet4Address }?.hostAddress
            ipv4 ?: addrs.firstOrNull()?.hostAddress ?: host
        } catch (_: Exception) {
            host
        }
    }

    private fun setState(state: UiState) {
        val busy = state == UiState.CONNECTING || state == UiState.DISCONNECTING
        loadingBar.visibility = if (busy) View.VISIBLE else View.GONE
        connectButton.isEnabled = !busy
        disconnectButton.isEnabled = !busy
        when (state) {
            UiState.IDLE -> if (!statusText.text.toString().startsWith("状态：错误")) {
                statusText.text = getString(R.string.status_idle)
            }
            UiState.CONNECTING -> statusText.text = getString(R.string.status_connecting)
            UiState.CONNECTED -> Unit
            UiState.DISCONNECTING -> statusText.text = getString(R.string.status_disconnecting)
        }
    }

    private fun localizeError(raw: String): String {
        val message = raw.trim()
        if (message.isEmpty()) return getString(R.string.error_unknown)
        val lower = message.lowercase()
        val authReason = Regex("auth_reason=([a-zA-Z0-9_\\-]+)").find(message)?.groupValues?.getOrNull(1)?.lowercase()

        if (lower.contains("go bridge not available")) {
            return getString(R.string.error_bridge_unavailable)
        }
        if (authReason == "missing_device_id") {
            return getString(R.string.error_missing_device_id)
        }
        if (
            lower.contains("device_limit_exceeded") ||
            authReason == "device_limit_exceeded" ||
            authReason?.contains("device_limit") == true
        ) {
            return getString(R.string.error_device_limit)
        }
        if (authReason == "invalid_device_ticket" || authReason == "expired_or_invalid" || authReason == "user_mismatch") {
            return getString(R.string.error_device_ticket_invalid)
        }
        if (authReason == "missing_token") {
            return getString(R.string.error_missing_token)
        }
        if (authReason == "disabled_user") {
            return getString(R.string.error_user_disabled)
        }
        if (authReason == "expired_user") {
            return getString(R.string.error_user_expired)
        }
        if (lower.contains("hostname") && lower.contains("not verified")) {
            return getString(R.string.error_cert_hostname)
        }
        if (lower.contains("certificate") || lower.contains("x509")) {
            return getString(R.string.error_cert_verify)
        }
        if (lower.contains("no such host")) {
            return getString(R.string.error_dns_resolve)
        }
        if (lower.contains("timeout")) {
            return getString(R.string.error_timeout)
        }
        if (lower.contains("connection refused")) {
            return getString(R.string.error_conn_refused)
        }
        if (lower.contains("status=401")) {
            return when {
                authReason?.contains("expired") == true -> getString(R.string.error_token_expired)
                authReason?.contains("token") == true -> getString(R.string.error_auth_failed)
                else -> getString(R.string.error_auth_failed)
            }
        }
        if (lower.contains("status=404")) {
            return getString(R.string.error_path_not_found)
        }
        if (lower.contains("status=400")) {
            return getString(R.string.error_bad_request)
        }
        if (lower.contains("status=403")) {
            return when {
                authReason == "device_limit_exceeded" || authReason?.contains("device_limit") == true -> getString(R.string.error_device_limit)
                else -> getString(R.string.error_forbidden)
            }
        }
        if (lower.contains("status=429")) {
            return getString(R.string.error_rate_limited)
        }
        if (lower.contains("status=502")) {
            return getString(R.string.error_bad_gateway)
        }
        if (lower.contains("status=503")) {
            return getString(R.string.error_service_overloaded)
        }
        if (Regex("status=5\\d\\d").containsMatchIn(lower)) {
            return getString(R.string.error_server_unavailable)
        }
        return message
    }
}

data class ApiResult(
    val ok: Boolean,
    val error: String,
    val nextDeviceTicket: String = ""
)

data class SessionStatusResult(
    val ok: Boolean,
    val error: String,
    val expireAt: String = "",
    val remainingDays: Int = -1,
    val expired: Boolean = false
)

data class BridgeStatsResult(
    val running: Boolean,
    val lastError: String = "",
    val proxy: String = "",
    val mtu: Int = 0,
    val logLevel: String = ""
)
