package com.fourpx.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import java.lang.reflect.Method
import java.util.concurrent.atomic.AtomicBoolean

class FourPxVpnService : VpnService() {
    private var vpnInterface: ParcelFileDescriptor? = null
    private val running = AtomicBoolean(false)
    private var engineBridgeClass: Class<*>? = null
    private var engineStopMethodName: String = ""

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONNECT -> {
                val socksHost = intent.getStringExtra(EXTRA_SOCKS_HOST) ?: DEFAULT_SOCKS_HOST
                val socksPort = intent.getIntExtra(EXTRA_SOCKS_PORT, DEFAULT_SOCKS_PORT)
                val configJson = intent.getStringExtra(EXTRA_TUNBRIDGE_CONFIG_JSON).orEmpty()
                startVpn(socksHost, socksPort, configJson)
            }
            ACTION_DISCONNECT -> stopVpn()
            else -> Unit
        }
        return Service.START_STICKY
    }

    override fun onDestroy() {
        stopVpn()
        super.onDestroy()
    }

    override fun onRevoke() {
        stopVpn()
        super.onRevoke()
    }

    private fun startVpn(socksHost: String, socksPort: Int, configJson: String) {
        if (running.get()) return
        AppLog.i(TAG, "start vpn socks=$socksHost:$socksPort")
        val builder = Builder()
            .setSession("4px Mobile")
            .setMtu(1500)
            .addAddress("10.8.0.2", 32)
            .addDnsServer("1.1.1.1")
            .addRoute("0.0.0.0", 0)
        try {
            // Avoid forwarding this app's own upstream sockets back into VPN.
            builder.addDisallowedApplication(packageName)
        } catch (_: PackageManager.NameNotFoundException) {
        }

        val established = builder.establish() ?: return
        // Detach FD ownership before passing into Go runtime to avoid fdsan double-close crashes.
        val tunFd = established.detachFd()
        vpnInterface = null
        startForeground(NOTIFICATION_ID, buildNotification())
        val proxy = "socks5://$socksHost:$socksPort"
        val started = startTun2SocksBridge(tunFd, proxy, configJson)
        if (!started) {
            Log.e(TAG, "start tun2socks bridge failed, proxy=$proxy")
            AppLog.e(TAG, "start bridge failed proxy=$proxy")
            try {
                ParcelFileDescriptor.adoptFd(tunFd).close()
            } catch (_: Exception) {
            }
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        AppLog.i(TAG, "vpn started")
        running.set(true)
    }

    private fun stopVpn() {
        AppLog.i(TAG, "stop vpn requested")
        stopTun2SocksBridge()
        if (!running.getAndSet(false)) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        // Tun fd ownership was detached and transferred to Go engine.
        vpnInterface = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        AppLog.i(TAG, "vpn stopped")
    }

    private fun startTun2SocksBridge(tunFd: Int, proxy: String, configJson: String): Boolean {
        // Expected gomobile API:
        // package tunbridge
        // func Start(fd int, proxy string) error
        // func Stop() error
        val candidates = listOf(
            "go.tunbridge.Tunbridge",
            "tunbridge.Tunbridge"
        )
        for (className in candidates) {
            try {
                val cls = Class.forName(className)
                if (configJson.isNotBlank()) {
                    applyTunbridgeConfig(cls, configJson)
                }
                val startMethod = resolveStartMethod(cls)
                val ret = if (startMethod.parameterTypes.firstOrNull() == Long::class.javaPrimitiveType || startMethod.parameterTypes.firstOrNull() == Long::class.java) {
                    startMethod.invoke(null, tunFd.toLong(), proxy)
                } else {
                    startMethod.invoke(null, tunFd, proxy)
                }
                if (ret is Throwable) {
                    Log.e(TAG, "tunbridge start returned throwable", ret)
                    AppLog.e(TAG, "bridge start returned throwable: ${ret.message}")
                    return false
                }
                engineBridgeClass = cls
                engineStopMethodName = resolveStopMethod(cls).name
                Log.i(TAG, "tun2socks bridge started via $className")
                AppLog.i(TAG, "bridge started via $className")
                return true
            } catch (err: ClassNotFoundException) {
                continue
            } catch (err: NoSuchMethodException) {
                Log.e(TAG, "tunbridge start method not found in $className", err)
                AppLog.e(TAG, "bridge start method missing in $className")
                return false
            } catch (err: Exception) {
                Log.e(TAG, "tunbridge start failed in $className", err)
                AppLog.e(TAG, "bridge start failed in $className: ${err.message}")
                return false
            }
        }
        Log.e(TAG, "tun2socks bridge class not found, ensure tun2socks.aar is present")
        AppLog.e(TAG, "bridge class not found, check tun2socks.aar")
        return false
    }

    private fun applyTunbridgeConfig(cls: Class<*>, configJson: String) {
        try {
            val updateMethod = resolveUpdateConfigMethod(cls)
            updateMethod.invoke(null, configJson)
        } catch (_: NoSuchMethodException) {
            Log.w(TAG, "tunbridge UpdateConfig not found, continue with defaults")
            AppLog.i(TAG, "bridge UpdateConfig missing, continue defaults")
        }
    }

    private fun resolveStartMethod(cls: Class<*>): Method {
        val methods = cls.methods
        val candidate = methods.firstOrNull { m ->
            (m.name == "Start" || m.name == "start") &&
                m.parameterTypes.size == 2 &&
                m.parameterTypes[1] == String::class.java &&
                (
                    m.parameterTypes[0] == Int::class.javaPrimitiveType ||
                    m.parameterTypes[0] == Int::class.java ||
                    m.parameterTypes[0] == Long::class.javaPrimitiveType ||
                    m.parameterTypes[0] == Long::class.java
                )
        }
        return candidate ?: throw NoSuchMethodException("${cls.name}.Start/start(fd, proxy)")
    }

    private fun resolveUpdateConfigMethod(cls: Class<*>): Method {
        val methods = cls.methods
        val candidate = methods.firstOrNull { m ->
            (m.name == "UpdateConfig" || m.name == "updateConfig") &&
                m.parameterTypes.size == 1 &&
                m.parameterTypes[0] == String::class.java
        }
        return candidate ?: throw NoSuchMethodException("${cls.name}.UpdateConfig/updateConfig(configJson)")
    }

    private fun resolveStopMethod(cls: Class<*>): Method {
        val methods = cls.methods
        val candidate = methods.firstOrNull { m ->
            (m.name == "Stop" || m.name == "stop") && m.parameterTypes.isEmpty()
        }
        return candidate ?: throw NoSuchMethodException("${cls.name}.Stop/stop()")
    }

    private fun stopTun2SocksBridge() {
        val cls = engineBridgeClass ?: return
        try {
            val stopMethod = cls.getMethod(engineStopMethodName)
            val ret = stopMethod.invoke(null)
            if (ret is Throwable) {
                Log.w(TAG, "tunbridge stop returned throwable", ret)
                AppLog.e(TAG, "bridge stop returned throwable: ${ret.message}")
            }
        } catch (err: Exception) {
            Log.w(TAG, "tunbridge stop failed", err)
            AppLog.e(TAG, "bridge stop failed: ${err.message}")
        } finally {
            engineBridgeClass = null
            engineStopMethodName = ""
        }
    }

    private fun buildNotification(): Notification {
        ensureChannel()
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pendingIntent = PendingIntent.getActivity(this, 0, openIntent, pendingFlags)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("4px VPN")
            .setContentText("VPN service running")
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "4px VPN",
            NotificationManager.IMPORTANCE_LOW
        )
        nm.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "FourPxVpnService"
        private const val ACTION_CONNECT = "com.fourpx.mobile.vpn.CONNECT"
        private const val ACTION_DISCONNECT = "com.fourpx.mobile.vpn.DISCONNECT"
        private const val CHANNEL_ID = "fourpx_vpn_channel"
        private const val NOTIFICATION_ID = 1001
        private const val EXTRA_SOCKS_HOST = "extra_socks_host"
        private const val EXTRA_SOCKS_PORT = "extra_socks_port"
        private const val EXTRA_TUNBRIDGE_CONFIG_JSON = "extra_tunbridge_config_json"
        private const val DEFAULT_SOCKS_HOST = "127.0.0.1"
        private const val DEFAULT_SOCKS_PORT = 1080

        fun start(
            context: Context,
            socksHost: String = DEFAULT_SOCKS_HOST,
            socksPort: Int = DEFAULT_SOCKS_PORT,
            tunbridgeConfigJson: String = ""
        ) {
            val intent = Intent(context, FourPxVpnService::class.java)
                .setAction(ACTION_CONNECT)
                .putExtra(EXTRA_SOCKS_HOST, socksHost)
                .putExtra(EXTRA_SOCKS_PORT, socksPort)
                .putExtra(EXTRA_TUNBRIDGE_CONFIG_JSON, tunbridgeConfigJson)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, FourPxVpnService::class.java).setAction(ACTION_DISCONNECT)
            context.startService(intent)
        }
    }
}
