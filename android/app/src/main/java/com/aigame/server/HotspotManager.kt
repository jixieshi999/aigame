package com.aigame.server

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * 负责 Android LocalOnlyHotspot（免流量临时专属热点）的生命周期管理、
 * SSID/密码读取、标准 Wi-Fi 二维码生成及故障降级处理。
 *
 * 系统版本适配说明：
 * - Android 8.0 (API 26) 引入 startLocalOnlyHotspot。
 * - Android 11/12 (API 30/31)：凭证通过 reservation.wifiConfiguration (WifiConfiguration) 获取。
 * - Android 13+ (API 33+)：引入 reservation.softApConfiguration (SoftApConfiguration)，弃用 wifiConfiguration。
 * - 权限：Android 8~12 需要 ACCESS_FINE_LOCATION；Android 13+ 增加 NEARBY_WIFI_DEVICES 权限要求。
 */
class HotspotManager(
    private val context: Context,
    private val listener: HotspotListener
) {
    interface HotspotListener {
        fun onHotspotStarted(ssid: String, password: String, wifiQrString: String)
        fun onHotspotStopped()
        fun onHotspotFailed(reasonCode: Int, message: String, fallbackGuidance: String)
    }

    private val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null

    var currentSsid: String? = null
        private set
    var currentPassword: String? = null
        private set
    var currentWifiQr: String? = null
        private set

    val isRunning: Boolean
        get() = reservation != null

    /**
     * 检查当前系统启动 LocalOnlyHotspot 所需的所有运行时权限。
     */
    fun hasRequiredPermissions(): Boolean {
        val fineLocation = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        val nearbyWifi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.NEARBY_WIFI_DEVICES
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }

        return fineLocation && nearbyWifi
    }

    /**
     * 获取当前系统启动热点缺失的权限清单。
     */
    fun getMissingPermissions(): Array<String> {
        val missing = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED) {
                missing.add(Manifest.permission.NEARBY_WIFI_DEVICES)
            }
        }
        return missing.toTypedArray()
    }

    /**
     * 启动 LocalOnlyHotspot 临时热点。
     */
    fun startHotspot() {
        if (wifiManager == null) {
            listener.onHotspotFailed(-1, "系统 Wi-Fi 服务不可用", "请检查当前设备是否支持无线网卡硬件。")
            return
        }

        if (reservation != null) {
            val ssid = currentSsid ?: "JiMao-Hotspot"
            val pwd = currentPassword ?: ""
            val qr = currentWifiQr ?: formatWifiQrString(ssid, pwd)
            listener.onHotspotStarted(ssid, pwd, qr)
            return
        }

        if (!hasRequiredPermissions()) {
            listener.onHotspotFailed(-2, "缺少热点运行权限", "需要授予精确位置权限（及周边设备权限）方可启动临时热点。")
            return
        }

        try {
            wifiManager.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
                override fun onStarted(res: WifiManager.LocalOnlyHotspotReservation) {
                    super.onStarted(res)
                    reservation = res
                    val (ssid, password) = extractCredentials(res)
                    currentSsid = ssid
                    currentPassword = password
                    val qr = formatWifiQrString(ssid, password)
                    currentWifiQr = qr
                    Log.i(TAG, "LocalOnlyHotspot 启动成功: SSID=$ssid, Password=$password")
                    mainHandler.post {
                        listener.onHotspotStarted(ssid, password, qr)
                    }
                }

                override fun onStopped() {
                    super.onStopped()
                    Log.i(TAG, "LocalOnlyHotspot 已由系统停止")
                    reservation = null
                    currentSsid = null
                    currentPassword = null
                    currentWifiQr = null
                    mainHandler.post {
                        listener.onHotspotStopped()
                    }
                }

                override fun onFailed(reason: Int) {
                    super.onFailed(reason)
                    reservation = null
                    currentSsid = null
                    currentPassword = null
                    currentWifiQr = null
                    val (reasonMsg, guidance) = parseFailureReason(reason)
                    Log.w(TAG, "LocalOnlyHotspot 启动失败: reason=$reason ($reasonMsg)")
                    mainHandler.post {
                        listener.onHotspotFailed(reason, reasonMsg, guidance)
                    }
                }
            }, mainHandler)
        } catch (e: SecurityException) {
            Log.e(TAG, "权限异常无法启动热点", e)
            listener.onHotspotFailed(-2, "权限不足: ${e.message}", "请在系统设置中为本应用开启位置权限与周边设备权限。")
        } catch (e: IllegalStateException) {
            Log.e(TAG, "状态异常无法启动热点", e)
            listener.onHotspotFailed(-3, "系统 Wi-Fi 状态冲突", "请确认 Wi-Fi 已开启且未连接到禁止热点的网络，或直接开启系统个人热点。")
        } catch (e: Throwable) {
            Log.e(TAG, "启动热点发生意外错误", e)
            listener.onHotspotFailed(-4, "启动异常: ${e.message}", "模拟器或部分机型不支持 LocalOnlyHotspot，建议下拉通知栏手动开启系统【个人热点】。")
        }
    }

    /**
     * 停止临时热点并释放系统资源。
     */
    fun stopHotspot() {
        try {
            reservation?.close()
        } catch (e: Throwable) {
            Log.w(TAG, "关闭热点 reservation 异常", e)
        } finally {
            reservation = null
            currentSsid = null
            currentPassword = null
            currentWifiQr = null
            listener.onHotspotStopped()
        }
    }

    /**
     * 兼容跨 Android 版本的 SSID 与预共享密钥提取逻辑。
     */
    private fun extractCredentials(res: WifiManager.LocalOnlyHotspotReservation): Pair<String, String> {
        var ssid = "JiMao-Hotspot"
        var password = ""

        // Android 13+ (API 33) 优先通过 softApConfiguration 提取
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                val softApConfig = res.softApConfiguration
                if (softApConfig != null) {
                    val s = softApConfig.ssid
                    val p = softApConfig.passphrase
                    if (!s.isNullOrBlank()) ssid = s
                    if (!p.isNullOrBlank()) password = p
                }
            } catch (e: Throwable) {
                Log.w(TAG, "从 SoftApConfiguration 读取凭证异常，尝试降级", e)
            }
        }

        // Android 8.0 ~ 12 降级或补充提取
        if (password.isEmpty()) {
            try {
                @Suppress("DEPRECATION")
                val wifiConfig = res.wifiConfiguration
                if (wifiConfig != null) {
                    wifiConfig.SSID?.let {
                        val cleaned = it.removeSurrounding("\"")
                        if (cleaned.isNotBlank()) ssid = cleaned
                    }
                    wifiConfig.preSharedKey?.let {
                        val cleaned = it.removeSurrounding("\"")
                        if (cleaned.isNotBlank()) password = cleaned
                    }
                }
            } catch (e: Throwable) {
                Log.w(TAG, "从 WifiConfiguration 读取凭证异常", e)
            }
        }

        return Pair(ssid, password)
    }

    private fun parseFailureReason(reason: Int): Pair<String, String> {
        return when (reason) {
            WifiManager.LocalOnlyHotspotCallback.ERROR_NO_CHANNEL ->
                Pair("信道不可用 (ERROR_NO_CHANNEL)", "系统无法分配无线频段信道。请尝试关闭 Wi-Fi 重新开启，或手动开启系统个人热点。")
            WifiManager.LocalOnlyHotspotCallback.ERROR_GENERIC ->
                Pair("通用错误 (ERROR_GENERIC)", "底层硬件或驱动返回错误。模拟器通常由于缺少真实无线网卡而无法创建热点，建议连接 Wi-Fi 或在真机使用。")
            WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE ->
                Pair("工作模式冲突 (ERROR_INCOMPATIBLE_MODE)", "当前 Wi-Fi 工作模式与自建热点冲突（例如正连接至特定企业网络）。建议断开 Wi-Fi 或开启系统个人热点。")
            WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED ->
                Pair("网络共享受限 (ERROR_TETHERING_DISALLOWED)", "设备策略或系统安全设置禁止创建网络热点。")
            else ->
                Pair("未知原因 (错误码 $reason)", "建议下拉状态栏手动开启系统【个人热点】，应用将自动识别热点网段。")
        }
    }

    companion object {
        private const val TAG = "HotspotManager"

        /**
         * 按照 ZXing / Android 标准格式拼装 Wi-Fi 二维码内容：
         * WIFI:T:WPA;S:<SSID>;P:<PASSWORD>;;
         * 特殊字符（\ ; , : "）自动进行反斜杠转义。
         */
        fun formatWifiQrString(ssid: String, password: String, hidden: Boolean = false): String {
            val authType = if (password.isEmpty()) "nopass" else "WPA"
            val escapedSsid = escapeWifiValue(ssid)
            val escapedPwd = escapeWifiValue(password)
            val hiddenField = if (hidden) "H:true;" else ""
            return "WIFI:T:$authType;S:$escapedSsid;P:$escapedPwd;$hiddenField;"
        }

        /**
         * 对 Wi-Fi 二维码中的特殊符号进行转义。
         */
        fun escapeWifiValue(value: String): String {
            val sb = StringBuilder()
            for (c in value) {
                if (c == '\\' || c == ';' || c == ',' || c == ':' || c == '"') {
                    sb.append('\\')
                }
                sb.append(c)
            }
            return sb.toString()
        }
    }
}
