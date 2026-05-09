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
import androidx.activity.result.contract.ActivityResultContracts
import com.google.android.material.checkbox.MaterialCheckBox
import com.google.android.material.textfield.TextInputEditText
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var hostInput: TextInputEditText
    private lateinit var portInput: TextInputEditText
    private lateinit var tokenInput: TextInputEditText
    private lateinit var ticketInput: TextInputEditText
    private lateinit var probeHostInput: TextInputEditText
    private lateinit var probePortInput: TextInputEditText
    private lateinit var insecureTlsCheck: MaterialCheckBox
    private lateinit var saveButton: Button
    private lateinit var connectButton: Button
    private lateinit var disconnectButton: Button
    private lateinit var loadingBar: ProgressBar
    private lateinit var statusText: TextView

    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private lateinit var configStore: ConfigStore
    private val api = FourPxApi()
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
    }

    override fun onDestroy() {
        ioExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun bindViews() {
        hostInput = findViewById(R.id.hostInput)
        portInput = findViewById(R.id.portInput)
        tokenInput = findViewById(R.id.tokenInput)
        ticketInput = findViewById(R.id.ticketInput)
        probeHostInput = findViewById(R.id.probeHostInput)
        probePortInput = findViewById(R.id.probePortInput)
        insecureTlsCheck = findViewById(R.id.insecureTlsCheck)
        saveButton = findViewById(R.id.saveButton)
        connectButton = findViewById(R.id.connectButton)
        disconnectButton = findViewById(R.id.disconnectButton)
        loadingBar = findViewById(R.id.loadingBar)
        statusText = findViewById(R.id.statusText)
    }

    private fun bindActions() {
        saveButton.setOnClickListener {
            val cfg = readConfigFromInputs() ?: return@setOnClickListener
            configStore.save(cfg)
            Toast.makeText(this, getString(R.string.toast_saved), Toast.LENGTH_SHORT).show()
        }
        connectButton.setOnClickListener {
            val cfg = readConfigFromInputs() ?: return@setOnClickListener
            configStore.save(cfg)
            requestVpnPermissionThenConnect(cfg)
        }
        disconnectButton.setOnClickListener {
            val cfg = readConfigFromInputs() ?: return@setOnClickListener
            if (cfg.deviceTicket.isBlank()) {
                showError(getString(R.string.error_ticket_required))
                return@setOnClickListener
            }
            configStore.save(cfg)
            doDisconnect(cfg)
        }
    }

    private fun readConfigFromInputs(): AppConfig? {
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
        val probeHost = probeHostInput.text?.toString()?.trim().orEmpty()
        if (probeHost.isEmpty()) {
            showError(getString(R.string.error_invalid_probe_host))
            return null
        }
        val probePort = probePortInput.text?.toString()?.trim()?.toIntOrNull() ?: -1
        if (probePort !in 1..65535) {
            showError(getString(R.string.error_invalid_probe_port))
            return null
        }
        return AppConfig(
            host = host,
            port = port,
            authToken = token,
            deviceTicket = ticketInput.text?.toString()?.trim().orEmpty(),
            probeHost = probeHost,
            probePort = probePort,
            insecureTls = insecureTlsCheck.isChecked
        )
    }

    private fun renderConfig(config: AppConfig) {
        hostInput.setText(config.host)
        portInput.setText(config.port.toString())
        tokenInput.setText(config.authToken)
        ticketInput.setText(config.deviceTicket)
        probeHostInput.setText(config.probeHost)
        probePortInput.setText(config.probePort.toString())
        insecureTlsCheck.isChecked = config.insecureTls
    }

    private fun doConnect(config: AppConfig) {
        setState(UiState.CONNECTING)
        ioExecutor.execute {
            val result = try {
                api.connect(config)
            } catch (err: Exception) {
                ApiResult(false, err.message ?: "connect failed")
            }
            runOnUiThread {
                if (!result.ok) {
                    showError(result.error)
                    setState(UiState.IDLE)
                    return@runOnUiThread
                }
                if (result.nextDeviceTicket.isNotBlank()) {
                    ticketInput.setText(result.nextDeviceTicket)
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
                FourPxVpnService.start(this)
                statusText.text = getString(R.string.status_vpn_started)
                setState(UiState.CONNECTED)
            }
        }
    }

    private fun doDisconnect(config: AppConfig) {
        setState(UiState.DISCONNECTING)
        ioExecutor.execute {
            val result = try {
                api.offline(config)
            } catch (err: Exception) {
                ApiResult(false, err.message ?: "disconnect failed")
            }
            runOnUiThread {
                if (!result.ok) {
                    showError(result.error)
                    setState(UiState.CONNECTED)
                    return@runOnUiThread
                }
                if (result.nextDeviceTicket.isNotBlank()) {
                    ticketInput.setText(result.nextDeviceTicket)
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
        statusText.text = getString(R.string.status_error, message)
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun setState(state: UiState) {
        val busy = state == UiState.CONNECTING || state == UiState.DISCONNECTING
        loadingBar.visibility = if (busy) View.VISIBLE else View.GONE
        saveButton.isEnabled = !busy
        connectButton.isEnabled = !busy
        disconnectButton.isEnabled = !busy
        when (state) {
            UiState.IDLE -> if (!statusText.text.toString().startsWith("Status: Error")) {
                statusText.text = getString(R.string.status_idle)
            }
            UiState.CONNECTING -> statusText.text = getString(R.string.status_connecting)
            UiState.CONNECTED -> Unit
            UiState.DISCONNECTING -> statusText.text = getString(R.string.status_disconnecting)
        }
    }
}
