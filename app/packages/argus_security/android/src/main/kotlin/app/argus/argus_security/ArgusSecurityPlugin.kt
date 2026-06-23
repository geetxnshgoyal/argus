package app.argus.argus_security

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.MethodChannel.MethodCallHandler
import io.flutter.plugin.common.MethodChannel.Result
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Argus native security module (Android).
 *
 * Session key (ADR-0008): a non-exportable P-256 key in the Android Keystore
 * (StrongBox when available), with no user-authentication requirement. It
 * proves that token refreshes come from this phone. The attempt key (which
 * requires device unlock) and attestation are added in M3.
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
        try {
            when (call.method) {
                "platformInfo" -> result.success(
                    mapOf(
                        "platform" to "android",
                        "osVersion" to Build.VERSION.RELEASE,
                        "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
                        "hardwareKeyStore" to hasStrongBox(),
                    )
                )
                "sessionPublicKey" -> result.success(b64url(ensureSessionKey().public.encoded))
                "signWithSessionKey" -> {
                    val data = call.argument<ByteArray>("data") ?: return result.error("bad_args", "data missing", null)
                    ensureSessionKey()
                    val sig = Signature.getInstance("SHA256withECDSA")
                    sig.initSign(keyStore().getKey(SESSION_ALIAS, null) as PrivateKey)
                    sig.update(data)
                    result.success(b64url(sig.sign()))
                }
                "resetSessionKey" -> {
                    keyStore().deleteEntry(SESSION_ALIAS)
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        } catch (e: Exception) {
            result.error("keystore_error", e.message ?: e.javaClass.simpleName, null)
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /** Creates the session key once; later calls return the existing pair. */
    private fun ensureSessionKey(): java.security.KeyPair {
        val ks = keyStore()
        val existing = ks.getEntry(SESSION_ALIAS, null) as? KeyStore.PrivateKeyEntry
        if (existing != null) return java.security.KeyPair(existing.certificate.publicKey, existing.privateKey)
        fun generate(strongBox: Boolean): java.security.KeyPair {
            val builder = KeyGenParameterSpec.Builder(SESSION_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
            if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
            val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            gen.initialize(builder.build())
            return gen.generateKeyPair()
        }
        return if (hasStrongBox()) {
            try {
                generate(true)
            } catch (e: StrongBoxUnavailableException) {
                generate(false)
            }
        } else {
            generate(false)
        }
    }

    /** StrongBox (a dedicated secure element) exists from Android 9 on some devices. */
    private fun hasStrongBox(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

    private fun b64url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
    }

    companion object {
        const val CHANNEL = "argus/security"
        const val SESSION_ALIAS = "argus_session_v1"
    }
}
