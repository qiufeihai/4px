package com.fourpx.mobile

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

class ConfigStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("fourpx_mobile_config", Context.MODE_PRIVATE)

    fun load(): AppConfig {
        return AppConfig(
            host = prefs.getString(KEY_HOST, "") ?: "",
            port = prefs.getInt(KEY_PORT, 6666),
            authToken = prefs.getString(KEY_AUTH_TOKEN, "") ?: "",
            deviceId = getOrCreateDeviceId(),
            deviceTicket = prefs.getString(KEY_DEVICE_TICKET, "") ?: ""
        )
    }

    fun save(config: AppConfig) {
        prefs.edit()
            .putString(KEY_HOST, config.host)
            .putInt(KEY_PORT, config.port)
            .putString(KEY_AUTH_TOKEN, config.authToken)
            .putString(KEY_DEVICE_ID, config.deviceId)
            .putString(KEY_DEVICE_TICKET, config.deviceTicket)
            .apply()
    }

    private fun getOrCreateDeviceId(): String {
        val existing = prefs.getString(KEY_DEVICE_ID, "")?.trim().orEmpty()
        if (existing.isNotEmpty()) {
            return existing
        }
        val created = "android-" + UUID.randomUUID().toString()
        prefs.edit().putString(KEY_DEVICE_ID, created).apply()
        return created
    }

    companion object {
        private const val KEY_HOST = "host"
        private const val KEY_PORT = "port"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_TICKET = "device_ticket"
    }
}
