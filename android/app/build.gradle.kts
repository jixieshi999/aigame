import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.aigame.server"
    compileSdk = 34
    ndkVersion = "23.1.7779620"

    defaultConfig {
        applicationId = "com.aigame.server"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        ndk {
            abiFilters.addAll(listOf("arm64-v8a", "armeabi-v7a", "x86_64"))
        }

        externalNativeBuild {
            cmake {
                cppFlags.add("-std=c++17")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.18.1"
        }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("src/main/jniLibs")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.webkit:webkit:1.11.0")

    // QR Code Generation
    implementation("com.google.zxing:core:3.5.3")
}

val syncNodeProjectAssets by tasks.registering {
    val repoRoot = rootDir.parentFile
    val htmlFile = File(repoRoot, "几猫国产3A大作_V1.html")
    val lanDir = File(repoRoot, "lan")
    val targetDir = file("src/main/assets/nodejs-project")
    val expectedHash = "9e55b5200b088adaf8e1152da04efc0d3b25e236e6baf2dee96f81e23e084966"

    inputs.file(htmlFile)
    inputs.dir(lanDir)
    outputs.dir(targetDir)

    doLast {
        if (!htmlFile.exists()) {
            throw GradleException("原游戏 HTML 文件不存在: ${htmlFile.absolutePath}")
        }
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(htmlFile.readBytes()).joinToString("") { "%02x".format(it) }
        if (hash.lowercase() != expectedHash.lowercase()) {
            throw GradleException("HTML SHA-256 校验失败! 期望: $expectedHash, 实际: $hash")
        }

        targetDir.deleteRecursively()
        targetDir.mkdirs()

        // 复制 HTML (二进制完整复制，不进行换行符转换)
        val targetHtml = File(targetDir, "几猫国产3A大作_V1.html")
        htmlFile.copyTo(targetHtml, overwrite = true)
        val copiedHash = digest.digest(targetHtml.readBytes()).joinToString("") { "%02x".format(it) }
        if (copiedHash.lowercase() != expectedHash.lowercase()) {
            throw GradleException("复制后的 HTML SHA-256 校验失败!")
        }

        // 复制所有 lan/*.js 运行时文件，自动排除 test/、media/、*.md、*.pid、*.log 等
        val targetLan = File(targetDir, "lan")
        targetLan.mkdirs()
        lanDir.listFiles { file -> file.isFile && file.name.endsWith(".js") }?.forEach { jsFile ->
            jsFile.copyTo(File(targetLan, jsFile.name), overwrite = true)
        }
        println("[Gradle] 成功同步 nodejs-project assets，SHA-256 校验通过: $hash")
    }
}

tasks.named("preBuild") {
    dependsOn(syncNodeProjectAssets)
}
