# 《几猫》Android 联机主机 App · 代码与架构审查报告

> 任务 ID: android-host-20261112  
> 日期: 2026-11-12  
> 审查对象: `android/` 目录现有工程与 `lan/` 联机服务端结合情况

---

## 审查结论汇总（已知问题逐项核实）

| 编号 | 审查项 | 核实结论 | 依据与现状说明 | 处理方案 |
|---|---|---|---|---|
| **1** | assets 手工拷贝导致脱节 | **完全属实** | 此前 `assets/nodejs-project` 为构建前手工拷贝，若根目录 `lan/` 升级（如 D 阶段新增 `flow-coop.js`，E 阶段新增 `flow-pvp.js`），手工拷贝必然脱节。 | 在 Gradle 中配置 `syncNodeProjectAssets` 任务，构建期自动同步根目录 HTML 和所有 `lan/*.js` 文件。 |
| **2** | assets 混入无关垃圾文件 | **完全属实** | 原 `assets/nodejs-project/lan/` 中混入了 `test/`、`media/`、`server-runtime.pid`、`*.log`、`*.md` 等，导致 APK 无端增大且可能泄露本地信息。 | 构建期同步任务中采用通配 `lan/*.js` 过滤，严格排除 test、media、文档与临时文件。 |
| **3** | 房间/模式/种子/端口写死 | **完全属实** | `MainActivity.kt` 硬编码了 `CAT`、`coop`、`4207/9001`、`8787`，没有房间自定义，端口冲突时无自动重试。 | 增加房间配置界面（房间名、模式、种子），持久化保存；端口冲突时自动尝试后续端口并更新二维码。 |
| **4** | 二维码网络地址单凭网卡名猜测 | **完全属实** | `NetworkUtils` 仅通过正则匹配网卡名 `wlan*`，未监听网络连接变化，切换 Wi-Fi 后二维码不刷新，也无法区分可用路由。 | 使用 `ConnectivityManager.NetworkCallback` 实时监听网络拓扑与可用 IPv4 地址；提供接口选择。 |
| **5** | 独立主机模式负载与发热问题 | **完全属实** | 原设计默认开启"独立主机"，由手机自身 WebView 加载游戏计算 3D 渲染与全量敌人 AI，极易发热降频，且未给用户明确性能提示。 | 改名为"本机兼任房主（实验性）"，默认关闭，增加发热提示，仅作为备用和战况监控。 |
| **6** | `os.networkInterfaces()` 权限异常 | **完全属实** | `lan/server.js` 启动时直接调用 `os.networkInterfaces()`，Android 环境部分机型因 SELinux/权限限制会抛出异常导致进程退出。 | 最小化修改：已在 `lan/server.js` 中增加 `try/catch` 保护与 `process.env.LAN_IP` 兜底，并单独提交。 |
| **7** | 内嵌 Node 版本不符与 ICU 缺失 | **完全属实** | `include/node/node_version.h` 显示为 `v18.20.4`（Node 18 LTS），而 `lan/README.md` 要求 Node 20+。且移动版编译时未带完整 ICU，导致正则 `\p{}` 和 `TextDecoder(fatal: true)` 抛错。 | 在日志与 UI 显式展示 `process.version`；已在 `lan/server.js` 增加了 ICU 降级兼容，并提供长期升级方案。 |
| **8** | 本机环境与调试文件污染 Git | **完全属实** | 根目录与 `android/` 下缺少完整 `.gitignore`，存在 `screen*.png`、`local.properties` 等本机文件。 | 完善 `.gitignore`，确保临时文件、截图（保留 1-2 张说明图于 docs）、二进制预编译库不被误提交。 |
| **9** | WebView 与状态生命周期细节 | **完全属实** | WebView 开启了不必要的 `allowFileAccess = true`；屏幕旋转或切后台时 Activity 重建导致服务状态和二维码丢失。 | 禁用 `allowFileAccess`；Activity 结合 `onSaveInstanceState` / ViewModel / Service 绑定保持状态。 |

---

## 重点技术细节审查

### 1. 内嵌 Node.js 版本 (Node 18 vs Node 20)
- **实际版本**: `v18.20.4` (LTS Hydrogen, NODE_MODULE_VERSION 108)。
- **与 Node 20+ 差异**:
  1. `lan/server.js` 依赖的 RFC6455 帧解码、crypto (如 `crypto.randomUUID()`, `crypto.createHash`)、WebSocket 握手逻辑在 Node 18.20.4 均完全原生支持。
  2. 差异主要在于**国际化组件 (ICU)**：`nodejs-mobile` 为轻量化通常以 `--without-intl` 编译。我们通过在 `lan/server.js` 中为 `TextDecoder` 和字符正则提供标准 fallback，已使 Node 18 完美运行全部局域网服务端逻辑。
  3. **长期升级建议**: 若后续阶段需接入 Node 20+ 特性，可从 nodejs 官方源码交叉编译带有完整 ICU 的 Android `libnode.so` (Node v20.x 或 v22.x LTS)。

### 2. 构建期同步机制设计
- 将 `assets/nodejs-project` 列入 `.gitignore`，声明为 Gradle 构建产物。
- 在 `app/build.gradle.kts` 中注册 `syncNodeProjectAssets` 任务：
  - 检查根目录 `几猫国产3A大作_V1.html`，计算 SHA-256，与预期值 `9e55b5200b088adaf8e1152da04efc0d3b25e236e6baf2dee96f81e23e084966` 核对，不一致直接报错中止。
  - 采用通配模式将 `lan/*.js` 同步到 `assets/nodejs-project/lan/`，彻底隔绝无关文件。
