package com.fourpx.mobile

import android.content.Context
import android.content.SharedPreferences

class ConfigStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("fourpx_mobile_config", Context.MODE_PRIVATE)

    fun load(): AppConfig {
        return AppConfig(
            host = prefs.getString(KEY_HOST, "") ?: "",
            port = prefs.getInt(KEY_PORT, 6666),
            authToken = prefs.getString(KEY_AUTH_TOKEN, "") ?: "",
            deviceTicket = prefs.getString(KEY_DEVICE_TICKET, "") ?: ""
        )
    }

    fun save(config: AppConfig) {
        prefs.edit()
            .putString(KEY_HOST, config.host)
            .putInt(KEY_PORT, config.port)
            .putString(KEY_AUTH_TOKEN, config.authToken)
            .putString(KEY_DEVICE_TICKET, config.deviceTicket)
            .apply()
    }

    companion object {
        private const val KEY_HOST = "host"
        private const val KEY_PORT = "port"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_DEVICE_TICKET = "device_ticket"
    }
}
