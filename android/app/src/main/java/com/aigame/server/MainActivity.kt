package com.aigame.server

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.aigame.server.databinding.ActivityMainBinding
import java.util.Random

class MainActivity : AppCompatActivity(), NodeServerService.LogListener {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: SharedPreferences
    private var nodeService: NodeServerService? = null
    private var isBound = false

    private var currentPort = 8787
    private var selectedIpCandidate: NetworkUtils.IpCandidate? = null
    private var availableCandidates: List<NetworkUtils.IpCandidate> = emptyList()
    private var currentJoinUrl = ""
    private var isSpectatorLoaded = false

    private var networkChangeWatcher: NetworkUtils.NetworkChangeWatcher? = null

    companion object {
        private const val PREFS_NAME = "JiMaoServerPrefs"
        private const val KEY_ROOM_NAME = "room_name"
        private const val KEY_MODE = "mode"
        private const val KEY_SEED = "seed"
        private const val KEY_ESEED = "eseed"
        private const val KEY_DEDICATED_HOST = "dedicated_host"
        private const val KEY_KEEP_SCREEN_ON = "keep_screen_on"
        private const val KEY_SELECTED_IP = "selected_ip"

        private const val DEFAULT_SEED = 4207
        private const val DEFAULT_ESEED = 9001
    }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as NodeServerService.LocalBinder
            nodeService = binder.getService()
            nodeService?.setLogListener(this@MainActivity)
            isBound = true
            updateServerUi(true)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            nodeService = null
            isBound = false
            updateServerUi(false)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        loadPersistedSettings()
        setupWindow()
        requestAppPermissions()
        setupListeners()
        setupSpectatorWebView()
        initNetworkWatcher()
        refreshNetworkCandidates(autoSelectDefault = true)

        // 默认不自动开启服务，等待用户确认或自动启动
        startServerService()
    }

    override fun onResume() {
        super.onResume()
        checkBatteryOptimization()
    }

    private fun loadPersistedSettings() {
        val savedRoom = prefs.getString(KEY_ROOM_NAME, null) ?: generateRandomRoomName()
        val savedMode = prefs.getString(KEY_MODE, "coop") ?: "coop"
        val savedSeed = prefs.getInt(KEY_SEED, DEFAULT_SEED)
        val savedEseed = prefs.getInt(KEY_ESEED, DEFAULT_ESEED)
        val savedHost = prefs.getBoolean(KEY_DEDICATED_HOST, false) // 默认关闭
        val savedKeepScreen = prefs.getBoolean(KEY_KEEP_SCREEN_ON, true)

        binding.etRoomName.setText(savedRoom)
        if (savedMode == "pvp") {
            binding.rbModePvp.isChecked = true
        } else {
            binding.rbModeCoop.isChecked = true
        }
        binding.etSeed.setText(savedSeed.toString())
        binding.etEseed.setText(savedEseed.toString())
        binding.switchDedicatedHost.isChecked = savedHost
        binding.cardSpectator.visibility = if (savedHost) View.VISIBLE else View.GONE
        binding.tvHostWarning.visibility = if (savedHost) View.VISIBLE else View.GONE
        binding.switchKeepScreenOn.isChecked = savedKeepScreen
    }

    private fun saveCurrentSettings() {
        val room = getSanitizedRoomName()
        val mode = if (binding.rbModePvp.isChecked) "pvp" else "coop"
        val seed = binding.etSeed.text.toString().toIntOrNull() ?: DEFAULT_SEED
        val eseed = binding.etEseed.text.toString().toIntOrNull() ?: DEFAULT_ESEED
        val host = binding.switchDedicatedHost.isChecked
        val keepScreen = binding.switchKeepScreenOn.isChecked

        prefs.edit().apply {
            putString(KEY_ROOM_NAME, room)
            putString(KEY_MODE, mode)
            putInt(KEY_SEED, seed)
            putInt(KEY_ESEED, eseed)
            putBoolean(KEY_DEDICATED_HOST, host)
            putBoolean(KEY_KEEP_SCREEN_ON, keepScreen)
            selectedIpCandidate?.let { putString(KEY_SELECTED_IP, it.ip) }
            apply()
        }
    }

    private fun generateRandomRoomName(): String {
        val chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        val random = Random()
        val suffix = (1..3).map { chars[random.nextInt(chars.length)] }.joinToString("")
        return "CAT$suffix"
    }

    private fun getSanitizedRoomName(): String {
        val raw = binding.etRoomName.text.toString().trim()
        val filtered = raw.replace(Regex("[^a-zA-Z0-9_-]"), "")
        return if (filtered.isNotEmpty()) filtered.take(32) else "CAT"
    }

    private fun setupWindow() {
        if (binding.switchKeepScreenOn.isChecked) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun requestAppPermissions() {
        val permissions = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                permissions.add(Manifest.permission.POST_NOTIFICATIONS)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.NEARBY_WIFI_DEVICES)
                != PackageManager.PERMISSION_GRANTED) {
                permissions.add(Manifest.permission.NEARBY_WIFI_DEVICES)
            }
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.ACCESS_FINE_LOCATION)
        }

        if (permissions.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, permissions.toTypedArray(), 101)
        }
    }

    private fun checkBatteryOptimization() {
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val isIgnoring = pm.isIgnoringBatteryOptimizations(packageName)
            binding.btnBatteryOpt.visibility = if (isIgnoring) View.GONE else View.VISIBLE
        }
    }

    private fun setupListeners() {
        binding.btnToggleServer.setOnClickListener {
            if (isBound && nodeService != null) {
                stopServerService()
            } else {
                startServerService()
            }
        }

        binding.switchKeepScreenOn.setOnCheckedChangeListener { _, isChecked ->
            setupWindow()
            saveCurrentSettings()
        }

        binding.switchDedicatedHost.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) {
                binding.cardSpectator.visibility = View.VISIBLE
                binding.tvHostWarning.visibility = View.VISIBLE
                isSpectatorLoaded = false
                loadHostSpectator()
            } else {
                isSpectatorLoaded = false
                binding.cardSpectator.visibility = View.GONE
                binding.tvHostWarning.visibility = View.GONE
                binding.wvSpectator.loadUrl("about:blank")
            }
            saveCurrentSettings()
        }

        binding.btnRandomRoom.setOnClickListener {
            binding.etRoomName.setText(generateRandomRoomName())
            saveCurrentSettings()
            updateJoinUrlAndQr()
        }

        binding.rgMode.setOnCheckedChangeListener { _, _ ->
            saveCurrentSettings()
            updateJoinUrlAndQr()
            if (binding.switchDedicatedHost.isChecked) {
                loadHostSpectator()
            }
        }

        val configWatcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                saveCurrentSettings()
                updateJoinUrlAndQr()
            }
        }
        binding.etRoomName.addTextChangedListener(configWatcher)
        binding.etSeed.addTextChangedListener(configWatcher)
        binding.etEseed.addTextChangedListener(configWatcher)

        binding.btnSwitchNetwork.setOnClickListener {
            showNetworkSelectionDialog()
        }

        binding.btnCopyUrl.setOnClickListener {
            copyUrlToClipboard()
        }

        binding.cardQrContainer.setOnClickListener {
            showLargeQrDialog()
        }

        binding.btnBatteryOpt.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                } catch (e: Exception) {
                    try {
                        startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    } catch (e2: Exception) {
                        Toast.makeText(this, "请在系统设置中允许本应用后台无限制运行", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
    }

    private fun copyUrlToClipboard() {
        if (currentJoinUrl.isNotEmpty()) {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("几猫链接", currentJoinUrl))
            Toast.makeText(this, "链接已复制到剪贴板", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showLargeQrDialog() {
        if (currentJoinUrl.isEmpty()) return
        val dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_qr_zoom, null)
        val ivZoomQr = dialogView.findViewById<ImageView>(R.id.ivZoomQr)
        val tvZoomUrl = dialogView.findViewById<TextView>(R.id.tvZoomUrl)
        val btnZoomCopy = dialogView.findViewById<View>(R.id.btnZoomCopy)
        val btnZoomClose = dialogView.findViewById<View>(R.id.btnZoomClose)

        val qrBitmap = QrCodeGenerator.generate(currentJoinUrl, 700, 700)
        ivZoomQr.setImageBitmap(qrBitmap)
        tvZoomUrl.text = currentJoinUrl

        val dialog = AlertDialog.Builder(this)
            .setView(dialogView)
            .setCancelable(true)
            .create()

        btnZoomCopy.setOnClickListener {
            copyUrlToClipboard()
        }
        btnZoomClose.setOnClickListener {
            dialog.dismiss()
        }

        dialog.show()
    }

    private fun initNetworkWatcher() {
        networkChangeWatcher = NetworkUtils.NetworkChangeWatcher(this) {
            refreshNetworkCandidates(autoSelectDefault = false)
        }
        networkChangeWatcher?.start()
    }

    private fun refreshNetworkCandidates(autoSelectDefault: Boolean) {
        availableCandidates = NetworkUtils.getAvailableIpCandidates(this)

        if (availableCandidates.isEmpty()) {
            selectedIpCandidate = null
            binding.tvNetworkInfo.text = "网络地址：⚠️ 无可用局域网连接（请连接 Wi-Fi 或开启热点）"
            binding.btnSwitchNetwork.visibility = View.GONE
            binding.cardQrCode.visibility = View.GONE
            binding.tvJoinUrl.text = "请先连接 Wi-Fi 或开启手机热点"
            return
        }

        binding.cardQrCode.visibility = View.VISIBLE
        binding.btnSwitchNetwork.visibility = if (availableCandidates.size > 1) View.VISIBLE else View.GONE

        val savedIp = prefs.getString(KEY_SELECTED_IP, null)
        val matchSaved = availableCandidates.firstOrNull { it.ip == savedIp }

        selectedIpCandidate = if (!autoSelectDefault && selectedIpCandidate != null && availableCandidates.any { it.ip == selectedIpCandidate?.ip }) {
            availableCandidates.first { it.ip == selectedIpCandidate?.ip }
        } else if (matchSaved != null) {
            matchSaved
        } else {
            availableCandidates.first()
        }

        binding.tvNetworkInfo.text = "网络地址：${selectedIpCandidate?.displayName}"
        updateJoinUrlAndQr()
    }

    private fun showNetworkSelectionDialog() {
        if (availableCandidates.size <= 1) return
        val items = availableCandidates.map { it.displayName }.toTypedArray()
        val currentIndex = availableCandidates.indexOfFirst { it.ip == selectedIpCandidate?.ip }.coerceAtLeast(0)

        AlertDialog.Builder(this)
            .setTitle("选择对外广播的网络接口")
            .setSingleChoiceItems(items, currentIndex) { dialog, which ->
                selectedIpCandidate = availableCandidates[which]
                binding.tvNetworkInfo.text = "网络地址：${selectedIpCandidate?.displayName}"
                prefs.edit().putString(KEY_SELECTED_IP, selectedIpCandidate?.ip).apply()
                updateJoinUrlAndQr()
                dialog.dismiss()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun updateJoinUrlAndQr() {
        val candidate = selectedIpCandidate ?: return
        val room = getSanitizedRoomName()
        val mode = if (binding.rbModePvp.isChecked) "pvp" else "coop"
        val seed = binding.etSeed.text.toString().toIntOrNull() ?: DEFAULT_SEED
        val eseed = binding.etEseed.text.toString().toIntOrNull() ?: DEFAULT_ESEED

        currentJoinUrl = "http://${candidate.ip}:$currentPort/?seed=$seed&eseed=$eseed&lanRoom=$room&lanMode=$mode&lanAuto=1"
        binding.tvJoinUrl.text = currentJoinUrl

        val qrBitmap = QrCodeGenerator.generate(currentJoinUrl, 500, 500)
        if (qrBitmap != null) {
            binding.ivQrCode.setImageBitmap(qrBitmap)
        }
    }

    private fun setupSpectatorWebView() {
        binding.wvSpectator.apply {
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = false // 修复审查问题9：不需要直接读写本地文件系统
                cacheMode = WebSettings.LOAD_NO_CACHE
            }
            webViewClient = object : WebViewClient() {
                @Deprecated("Deprecated in Java")
                override fun onReceivedError(
                    view: WebView?,
                    errorCode: Int,
                    description: String?,
                    failingUrl: String?
                ) {
                    super.onReceivedError(view, errorCode, description, failingUrl)
                    if (binding.switchDedicatedHost.isChecked && !isSpectatorLoaded) {
                        view?.postDelayed({
                            loadHostSpectator()
                        }, 1500)
                    }
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    if (url != null && !url.contains("about:blank")) {
                        isSpectatorLoaded = true
                    }
                }
            }
            webChromeClient = object : WebChromeClient() {}
        }
    }

    private fun loadHostSpectator() {
        if (!binding.switchDedicatedHost.isChecked) return
        val room = getSanitizedRoomName()
        val mode = if (binding.rbModePvp.isChecked) "pvp" else "coop"
        val seed = binding.etSeed.text.toString().toIntOrNull() ?: DEFAULT_SEED
        val eseed = binding.etEseed.text.toString().toIntOrNull() ?: DEFAULT_ESEED

        val hostUrl = "http://127.0.0.1:$currentPort/?seed=$seed&eseed=$eseed&lanRoom=$room&lanName=主机AI&lanMode=$mode&lanAuto=1&q=low"
        binding.wvSpectator.loadUrl(hostUrl)
    }

    private fun startServerService() {
        binding.tvServerStatus.text = getString(R.string.status_starting)
        isSpectatorLoaded = false

        // 探测可用端口，若 8787 占用则自动递增
        val probePort = NetworkUtils.findAvailablePort(8787)
        if (probePort != currentPort) {
            currentPort = probePort
            onLog("端口 8787 已被占用，已自动切换至端口 $currentPort", false)
        }

        updateJoinUrlAndQr()

        val serviceIntent = Intent(this, NodeServerService::class.java).apply {
            putExtra(NodeServerService.EXTRA_PORT, currentPort)
            selectedIpCandidate?.let { putExtra(NodeServerService.EXTRA_LAN_IP, it.ip) }
        }
        ContextCompat.startForegroundService(this, serviceIntent)
        bindService(serviceIntent, serviceConnection, Context.BIND_AUTO_CREATE)

        if (binding.switchDedicatedHost.isChecked) {
            binding.wvSpectator.postDelayed({
                if (binding.switchDedicatedHost.isChecked && !isSpectatorLoaded) {
                    loadHostSpectator()
                }
            }, 3000)
        }
    }

    private fun stopServerService() {
        if (isBound) {
            unbindService(serviceConnection)
            isBound = false
        }
        val serviceIntent = Intent(this, NodeServerService::class.java)
        stopService(serviceIntent)
        nodeService = null
        updateServerUi(false)
        isSpectatorLoaded = false
        binding.wvSpectator.loadUrl("about:blank")
    }

    private fun updateServerUi(running: Boolean) {
        if (running) {
            binding.indicatorStatus.setBackgroundResource(R.drawable.shape_dot_green)
            binding.tvServerStatus.text = "服务状态：运行中 (端口 $currentPort)"
            binding.btnToggleServer.text = getString(R.string.btn_stop)
            binding.btnToggleServer.setBackgroundColor(ContextCompat.getColor(this, R.color.alarm_red))
        } else {
            binding.indicatorStatus.setBackgroundResource(R.drawable.shape_dot_red)
            binding.tvServerStatus.text = getString(R.string.status_stopped)
            binding.btnToggleServer.text = getString(R.string.btn_start)
            binding.btnToggleServer.setBackgroundColor(ContextCompat.getColor(this, R.color.signal_amber))
        }
    }

    private fun isNoisyLog(line: String): Boolean {
        return line.contains("mailbox=") ||
                line.contains("representation=") ||
                line.contains("image_count") ||
                line.contains("Backing") ||
                line.contains("has_refs") ||
                line.contains("dtor") ||
                line.contains("FactoryRef") ||
                line.contains("SharedImage") ||
                line.contains("shared_image") ||
                line.contains("chromium")
    }

    override fun onLog(line: String, isError: Boolean) {
        if (isNoisyLog(line)) return
        runOnUiThread {
            if (line.contains("Node 运行时：")) {
                val versionStr = line.substringAfter("Node 运行时：").trim()
                binding.tvNodeVersion.text = "运行核心：Node.js $versionStr (移动剪裁版)"
            }
            if (line.contains("http://localhost:$currentPort/") || line.contains("http://127.0.0.1:$currentPort/")) {
                if (binding.switchDedicatedHost.isChecked && !isSpectatorLoaded) {
                    loadHostSpectator()
                }
            }
            val prefix = if (isError) "[ERR] " else "[LOG] "
            if (binding.tvConsole.lineCount > 300) {
                val currentText = binding.tvConsole.text.toString()
                val cutIndex = currentText.indexOf('\n', currentText.length / 3)
                if (cutIndex != -1) {
                    binding.tvConsole.text = currentText.substring(cutIndex + 1)
                }
            }
            binding.tvConsole.append("$prefix$line\n")
            val scrollAmount = binding.tvConsole.layout?.let {
                it.getLineTop(binding.tvConsole.lineCount) - binding.tvConsole.height
            } ?: 0
            if (scrollAmount > 0) {
                binding.tvConsole.scrollTo(0, scrollAmount)
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        networkChangeWatcher?.stop()
        if (isBound) {
            unbindService(serviceConnection)
            isBound = false
        }
        binding.wvSpectator.destroy()
    }
}
