package com.aigame.server

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.aigame.server.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity(), NodeServerService.LogListener {

    private lateinit var binding: ActivityMainBinding
    private var nodeService: NodeServerService? = null
    private var isBound = false
    private var currentJoinUrl = ""

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

        setupWindow()
        requestAppPermissions()
        setupListeners()
        setupSpectatorWebView()
        refreshNetworkAndQr()

        // Auto-start node service on launch
        startServerService()
    }

    private fun setupWindow() {
        if (binding.switchKeepScreenOn.isChecked) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun requestAppPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    101
                )
            }
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
            if (isChecked) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        binding.switchDedicatedHost.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) {
                binding.cardSpectator.visibility = View.VISIBLE
                isSpectatorLoaded = false
                loadHostSpectator()
            } else {
                isSpectatorLoaded = false
                binding.cardSpectator.visibility = View.GONE
                binding.wvSpectator.loadUrl("about:blank")
            }
        }

        binding.btnCopyUrl.setOnClickListener {
            if (currentJoinUrl.isNotEmpty()) {
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("几猫链接", currentJoinUrl))
                Toast.makeText(this, "链接已复制到剪贴板", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private var isSpectatorLoaded = false

    private fun setupSpectatorWebView() {
        binding.wvSpectator.apply {
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = true
                cacheMode = WebSettings.LOAD_NO_CACHE
            }
            webViewClient = object : WebViewClient() {
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
                        }, 1200)
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
        val hostUrl = "http://127.0.0.1:8787/?seed=4207&eseed=9001&lanRoom=CAT&lanName=主机AI&lanMode=coop&lanAuto=1&q=low"
        binding.wvSpectator.loadUrl(hostUrl)
    }

    private fun refreshNetworkAndQr() {
        val netInfo = NetworkUtils.getLocalNetworkInfo(this)
        val port = 8787
        val room = "CAT"

        currentJoinUrl = "http://${netInfo.ip}:$port/?seed=4207&eseed=9001&lanRoom=$room&lanMode=coop&lanAuto=1"
        binding.tvNetworkInfo.text = "网络地址：${netInfo.description}"
        binding.tvJoinUrl.text = currentJoinUrl

        // Generate QR code
        val qrBitmap = QrCodeGenerator.generate(currentJoinUrl, 500, 500)
        if (qrBitmap != null) {
            binding.ivQrCode.setImageBitmap(qrBitmap)
        }
    }

    private fun startServerService() {
        binding.tvServerStatus.text = getString(R.string.status_starting)
        isSpectatorLoaded = false
        val serviceIntent = Intent(this, NodeServerService::class.java)
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
            binding.tvServerStatus.text = getString(R.string.status_running)
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
            if (line.contains("http://localhost:8787/") || line.contains("http://127.0.0.1:8787/")) {
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
            // Auto scroll to bottom
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
        if (isBound) {
            unbindService(serviceConnection)
            isBound = false
        }
        binding.wvSpectator.destroy()
    }
}
