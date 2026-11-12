package com.aigame.server

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import java.net.Inet4Address
import java.net.NetworkInterface

object NetworkUtils {

    enum class InterfaceType {
        WIFI,
        HOTSPOT,
        ETHERNET,
        OTHER
    }

    data class IpCandidate(
        val ip: String,
        val interfaceName: String,
        val type: InterfaceType,
        val isDefaultRoute: Boolean,
        val displayName: String
    ) {
        override fun toString(): String = displayName
    }

    /**
     * 自动探测可用端口，若目标端口已被占用，自动递增重试。
     */
    fun findAvailablePort(startPort: Int = 8787, maxTries: Int = 10): Int {
        for (port in startPort until (startPort + maxTries)) {
            try {
                java.net.ServerSocket(port).use {
                    return port
                }
            } catch (_: Exception) {
                // 端口被占用，尝试下一个
            }
        }
        return startPort
    }

    /**
     * 枚举所有当前可用且已启用的 IPv4 候选接口。
     * 排序规则：若 preferHotspot 为 true 则优先热点接口；
     * 否则优先排序：具有默认路由的 Wi-Fi > 其它 Wi-Fi > 热点接口 > 有线以太网 > 其它。
     */
    fun getAvailableIpCandidates(context: Context, preferHotspot: Boolean = false): List<IpCandidate> {
        val candidates = mutableListOf<IpCandidate>()
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        val activeNetwork = cm?.activeNetwork
        val activeLinkProperties = if (activeNetwork != null) cm.getLinkProperties(activeNetwork) else null
        val activeIps = activeLinkProperties?.linkAddresses?.mapNotNull { it.address as? Inet4Address }?.map { it.hostAddress } ?: emptyList()

        try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return emptyList()
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                if (intf.isLoopback || !intf.isUp) continue

                val name = intf.name.lowercase()
                val addrs = intf.inetAddresses

                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        val hostAddress = addr.hostAddress ?: continue
                        val isDefault = activeIps.contains(hostAddress)

                        val type = when {
                            name.contains("ap") || name.contains("softap") || name.contains("swlan") ||
                                hostAddress.startsWith("192.168.43.") || hostAddress.startsWith("192.168.49.") -> InterfaceType.HOTSPOT
                            name.contains("wlan") -> InterfaceType.WIFI
                            name.contains("eth") -> InterfaceType.ETHERNET
                            else -> InterfaceType.OTHER
                        }

                        val typeLabel = when (type) {
                            InterfaceType.WIFI -> "Wi-Fi 无线"
                            InterfaceType.HOTSPOT -> "手机热点"
                            InterfaceType.ETHERNET -> "以太网"
                            InterfaceType.OTHER -> "网络接口"
                        }

                        val routeLabel = if (isDefault) " [默认网络]" else ""
                        val displayName = "$typeLabel ($hostAddress)$routeLabel · $name"

                        candidates.add(
                            IpCandidate(
                                ip = hostAddress,
                                interfaceName = intf.name,
                                type = type,
                                isDefaultRoute = isDefault,
                                displayName = displayName
                            )
                        )
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }

        return if (preferHotspot) {
            candidates.sortedWith(
                compareByDescending<IpCandidate> { it.type == InterfaceType.HOTSPOT }
                    .thenByDescending { it.isDefaultRoute }
                    .thenByDescending { it.type == InterfaceType.WIFI }
                    .thenBy { it.interfaceName }
            )
        } else {
            candidates.sortedWith(
                compareByDescending<IpCandidate> { it.isDefaultRoute && it.type == InterfaceType.WIFI }
                    .thenByDescending { it.type == InterfaceType.WIFI }
                    .thenByDescending { it.type == InterfaceType.HOTSPOT }
                    .thenByDescending { it.isDefaultRoute }
                    .thenBy { it.interfaceName }
            )
        }
    }

    /**
     * 监听系统网络连接变化，并在变化时通过主线程回调通知。
     */
    class NetworkChangeWatcher(
        private val context: Context,
        private val onNetworkChanged: () -> Unit
    ) {
        private val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        private val mainHandler = Handler(Looper.getMainLooper())
        private var isRegistered = false

        private val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                notifyChange()
            }

            override fun onLost(network: Network) {
                notifyChange()
            }

            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                notifyChange()
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: android.net.LinkProperties) {
                notifyChange()
            }
        }

        private fun notifyChange() {
            mainHandler.post {
                onNetworkChanged()
            }
        }

        fun start() {
            if (isRegistered || connectivityManager == null) return
            try {
                val request = NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
                    .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
                    .build()
                connectivityManager.registerNetworkCallback(request, callback)
                isRegistered = true
            } catch (e: Exception) {
                // 部分旧系统尝试 registerDefaultNetworkCallback
                try {
                    connectivityManager.registerDefaultNetworkCallback(callback)
                    isRegistered = true
                } catch (e2: Exception) {
                    e2.printStackTrace()
                }
            }
        }

        fun stop() {
            if (!isRegistered || connectivityManager == null) return
            try {
                connectivityManager.unregisterNetworkCallback(callback)
            } catch (e: Exception) {
                e.printStackTrace()
            } finally {
                isRegistered = false
            }
        }
    }
}
