package com.fourpx.mobile

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class FourPxApi {
    fun connect(config: AppConfig): ApiResult {
        val client = buildClient(config.insecureTls)
        val reqBuilder = Request.Builder()
            .url("https://${config.host}:${config.port}/proxy")
            .post(ByteArray(0).toRequestBody("application/octet-stream".toMediaType()))
            .header("x-auth-token", config.authToken)
            .header("x-target-host", config.probeHost)
            .header("x-target-port", config.probePort.toString())
        if (config.deviceTicket.isNotBlank()) {
            reqBuilder.header("x-device-ticket", config.deviceTicket)
        }
        client.newCall(reqBuilder.build()).execute().use { response ->
            val nextTicket = response.header("x-device-ticket").orEmpty().trim()
            if (!response.isSuccessful) {
                val reason = response.header("x-auth-reason").orEmpty().trim()
                val msg = if (reason.isNotEmpty()) {
                    "status=${response.code} auth_reason=$reason"
                } else {
                    "status=${response.code}"
                }
                return ApiResult(false, msg, nextTicket)
            }
            return ApiResult(true, "", nextTicket)
        }
    }

    fun offline(config: AppConfig): ApiResult {
        if (config.deviceTicket.isBlank()) {
            return ApiResult(true, "")
        }
        val client = buildClient(config.insecureTls)
        val request = Request.Builder()
            .url("https://${config.host}:${config.port}/session/offline")
            .post(ByteArray(0).toRequestBody("application/octet-stream".toMediaType()))
            .header("x-auth-token", config.authToken)
            .header("x-device-ticket", config.deviceTicket)
            .build()
        client.newCall(request).execute().use { response ->
            val nextTicket = response.header("x-device-ticket").orEmpty().trim()
            if (!response.isSuccessful) {
                return ApiResult(false, "status=${response.code}", nextTicket)
            }
            return ApiResult(true, "", nextTicket)
        }
    }

    private fun buildClient(insecureTls: Boolean): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
        if (!insecureTls) {
            return builder.build()
        }
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val trustManagers = arrayOf<TrustManager>(trustAll)
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, trustManagers, SecureRandom())
        return builder
            .sslSocketFactory(sslContext.socketFactory, trustAll)
            .hostnameVerifier(HostnameVerifier { _, _ -> true })
            .build()
    }
}

data class ApiResult(
    val ok: Boolean,
    val error: String,
    val nextDeviceTicket: String = ""
)
