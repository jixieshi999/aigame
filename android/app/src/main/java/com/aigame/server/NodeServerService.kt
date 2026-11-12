package com.aigame.server

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import java.io.File

class NodeServerService : Service() {

    interface LogListener {
        fun onLog(line: String, isError: Boolean)
    }

    inner class LocalBinder : Binder() {
        fun getService(): NodeServerService = this@NodeServerService
    }

    private val binder = LocalBinder()
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var isNodeRunning = false
    private var logListener: LogListener? = null

    companion object {
        const val EXTRA_PORT = "extra_port"
        const val EXTRA_LAN_IP = "extra_lan_ip"
        private const val CHANNEL_ID = "JiMaoNodeServerChannel"
        private const val NOTIFICATION_ID = 8787

        init {
            try {
                System.loadLibrary("c++_shared")
            } catch (e: Throwable) {
                e.printStackTrace()
            }
            System.loadLibrary("node")
            System.loadLibrary("native-lib")
        }
    }

    private external fun startNodeWithArguments(
        arguments: Array<String>,
        modulesPath: String?,
        lanIp: String?
    ): Int
    private external fun registerLogCallback(callback: Any?)

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        acquireWakeLock()
        acquireWifiLock()

        // Register the log callback with native C++ bridge
        registerLogCallback(object : Any() {
            @Suppress("unused")
            fun onLog(message: String, isError: Boolean) {
                logListener?.onLog(message, isError)
            }
        })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val port = intent?.getIntExtra(EXTRA_PORT, 8787) ?: 8787
        val lanIp = intent?.getStringExtra(EXTRA_LAN_IP)
        val notification = createNotification("《几猫》游戏服务运行中 (0.0.0.0:$port)")
        startForeground(NOTIFICATION_ID, notification)

        if (!isNodeRunning) {
            isNodeRunning = true
            Thread {
                val projectDir = AssetSyncManager.syncNodeProject(applicationContext)
                val serverScript = File(projectDir, "lan/server.js").absolutePath

                val args = arrayOf("node", serverScript, port.toString())
                val exitCode = startNodeWithArguments(args, projectDir.absolutePath, lanIp)
                logListener?.onLog("Node 服务已退出，退出码: $exitCode", exitCode != 0)
                isNodeRunning = false
            }.start()
        }

        return START_STICKY
    }

    fun setLogListener(listener: LogListener?) {
        this.logListener = listener
    }

    fun isRunning(): Boolean = isNodeRunning

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "JiMao:NodeServerWakeLock").apply {
            setReferenceCounted(false)
            acquire(12 * 60 * 60 * 1000L) // 12 hours max
        }
    }

    private fun acquireWifiLock() {
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        wifiLock = wm?.createWifiLock(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            },
            "JiMao:NodeServerWifiLock"
        )?.apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "几猫联机主机服务",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "保证《几猫》局域网服务端在后台持续稳定运行"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(content: String): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("几猫联机主机 (Port: 8787)")
            .setContentText(content)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        super.onDestroy()
        registerLogCallback(null)
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wifiLock?.let {
            if (it.isHeld) it.release()
        }
    }
}
