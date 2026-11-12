package com.aigame.server

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import java.net.Inet4Address
import java.net.NetworkInterface

object NetworkUtils {

    data class NetworkInfo(
        val ip: String,
        val isHotspot: Boolean,
        val description: String
    )

    fun getLocalNetworkInfo(context: Context): NetworkInfo {
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            var fallbackIp: String? = null
            var apIp: String? = null

            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                if (intf.isLoopback || !intf.isUp) continue

                val name = intf.name.lowercase()
                val addrs = intf.inetAddresses

                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        val hostAddress = addr.hostAddress ?: continue

                        // Check common AP interfaces (ap0, wlan1, rndis0, etc.)
                        if (name.contains("ap") || name.contains("hotspot") || hostAddress.startsWith("192.168.43.")) {
                            apIp = hostAddress
                        } else if (name.contains("wlan") || name.contains("eth")) {
                            fallbackIp = hostAddress
                        } else if (fallbackIp == null) {
                            fallbackIp = hostAddress
                        }
                    }
                }
            }

            if (apIp != null) {
                return NetworkInfo(apIp, true, "个人热点模式 ($apIp)")
            }

            if (fallbackIp != null) {
                return NetworkInfo(fallbackIp, false, "局域网 Wi-Fi ($fallbackIp)")
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }

        // Default standard Android hotspot gateway
        return NetworkInfo("192.168.43.1", true, "默认热点地址 (192.168.43.1)")
    }
}
