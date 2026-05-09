package com.fourpx.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
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
                startVpn(socksHost, socksPort)
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

    private fun startVpn(socksHost: String, socksPort: Int) {
        if (running.get()) return
        val builder = Builder()
            .setSession("4px Mobile")
            .setMtu(1500)
            .addAddress("10.8.0.2", 32)
            .addDnsServer("1.1.1.1")
            .addRoute("0.0.0.0", 0)

        val established = builder.establish() ?: return
        vpnInterface = established
        startForeground(NOTIFICATION_ID, buildNotification())
        val proxy = "socks5://$socksHost:$socksPort"
        val started = startTun2SocksBridge(established.fd, proxy)
        if (!started) {
            Log.e(TAG, "start tun2socks bridge failed, proxy=$proxy")
            try {
                established.close()
            } catch (_: Exception) {
            }
            vpnInterface = null
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        running.set(true)
    }

    private fun stopVpn() {
        stopTun2SocksBridge()
        if (!running.getAndSet(false)) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        try {
            vpnInterface?.close()
        } catch (_: Exception) {}
        vpnInterface = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startTun2SocksBridge(tunFd: Int, proxy: String): Boolean {
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
                val startMethod = cls.getMethod("Start", Int::class.javaPrimitiveType, String::class.java)
                val ret = startMethod.invoke(null, tunFd, proxy)
                if (ret is Throwable) {
                    Log.e(TAG, "tunbridge start returned throwable", ret)
                    return false
                }
                engineBridgeClass = cls
                engineStopMethodName = "Stop"
                Log.i(TAG, "tun2socks bridge started via $className")
                return true
            } catch (err: ClassNotFoundException) {
                continue
            } catch (err: NoSuchMethodException) {
                Log.e(TAG, "tunbridge start method not found in $className", err)
                return false
            } catch (err: Exception) {
                Log.e(TAG, "tunbridge start failed in $className", err)
                return false
            }
        }
        Log.e(TAG, "tun2socks bridge class not found, ensure tun2socks.aar is present")
        return false
    }

    private fun stopTun2SocksBridge() {
        val cls = engineBridgeClass ?: return
        try {
            val stopMethod = cls.getMethod(engineStopMethodName)
            val ret = stopMethod.invoke(null)
            if (ret is Throwable) {
                Log.w(TAG, "tunbridge stop returned throwable", ret)
            }
        } catch (err: Exception) {
            Log.w(TAG, "tunbridge stop failed", err)
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
            .setSmallIcon(android.R.drawable.stat_sys_warning)
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
        private const val DEFAULT_SOCKS_HOST = "127.0.0.1"
        private const val DEFAULT_SOCKS_PORT = 1080

        fun start(context: Context, socksHost: String = DEFAULT_SOCKS_HOST, socksPort: Int = DEFAULT_SOCKS_PORT) {
            val intent = Intent(context, FourPxVpnService::class.java)
                .setAction(ACTION_CONNECT)
                .putExtra(EXTRA_SOCKS_HOST, socksHost)
                .putExtra(EXTRA_SOCKS_PORT, socksPort)
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
