package com.aigame.server

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

object AssetSyncManager {

    fun syncNodeProject(context: Context): File {
        val targetDir = File(context.filesDir, "nodejs-project")
        targetDir.deleteRecursively()
        targetDir.mkdirs()
        copyAssetFolder(context, "nodejs-project", targetDir)
        return targetDir
    }

    private fun copyAssetFolder(context: Context, assetPath: String, targetDir: File) {
        val assetManager = context.assets
        val files = assetManager.list(assetPath) ?: return

        for (filename in files) {
            val subAssetPath = "$assetPath/$filename"
            val subTarget = File(targetDir, filename)

            val children = assetManager.list(subAssetPath)
            if (!children.isNullOrEmpty()) {
                subTarget.mkdirs()
                copyAssetFolder(context, subAssetPath, subTarget)
            } else {
                // It's a file
                try {
                    val inputStream = assetManager.open(subAssetPath)
                    copyStreamToFile(inputStream, subTarget)
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }
    }

    private fun copyStreamToFile(inputStream: InputStream, targetFile: File) {
        inputStream.use { input ->
            FileOutputStream(targetFile).use { output ->
                input.copyTo(output)
            }
        }
    }
}
