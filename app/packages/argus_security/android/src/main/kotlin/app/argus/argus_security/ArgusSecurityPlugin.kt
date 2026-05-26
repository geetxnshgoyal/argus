package app.argus.argus_security

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.MethodChannel.MethodCallHandler
import io.flutter.plugin.common.MethodChannel.Result

/**
 * Argus native security module (Android).
 *
 * M0: reports device capabilities. M3 adds hardware-backed key generation
 * (Android Keystore / StrongBox), signing, key attestation and Play Integrity.
 */
class ArgusSecurityPlugin : FlutterPlugin, MethodCallHandler {
    private lateinit var channel: MethodChannel
    private lateinit var context: Context

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL)
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: Result) {
        when (call.method) {
            "platformInfo" -> result.success(
                mapOf(
                    "platform" to "android",
                    "osVersion" to Build.VERSION.RELEASE,
                    "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
                    "hardwareKeyStore" to hasStrongBox(),
                )
            )
            else -> result.notImplemented()
        }
    }

    /** StrongBox (a dedicated secure element) exists from Android 9 on some devices. */
    private fun hasStrongBox(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
    }

    companion object {
        const val CHANNEL = "argus/security"
    }
}
