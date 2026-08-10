package app.argus.argus_security

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import androidx.fragment.app.FragmentActivity
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.MethodChannel.MethodCallHandler
import io.flutter.plugin.common.MethodChannel.Result
import io.flutter.plugin.common.PluginRegistry
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Argus native security module (Android). No third-party Flutter plugins for
 * keys or attestation (spec §2); only Google's own Android libraries.
 *
 *  Session key (ADR-0008): Keystore P-256, no user auth. Proves token refreshes come from this phone.
 *  Attempt key (ADR-0008): Keystore P-256 that requires device unlock / strong biometric within a
 *    short window; generated with the server's challenge so its certificate chain is a key
 *    attestation (protocol §4). Signs attendance attempts.
 *  Play Integrity: standard requests bound to SHA-256 of the payload (ADR-0011).
 *  Location: one fresh, precise fix per scan with mock detection (spec §6); never in the background.
 */
class ArgusSecurityPlugin : FlutterPlugin, MethodCallHandler, ActivityAware, PluginRegistry.RequestPermissionsResultListener {
    private lateinit var channel: MethodChannel
    private lateinit var context: Context
    private var activity: Activity? = null
    private var binding: ActivityPluginBinding? = null
    private var pendingPermission: ((Boolean, Boolean) -> Unit)? = null
    private var integrityProvider: Pair<Long, StandardIntegrityTokenProvider>? = null

    override fun onAttachedToEngine(b: FlutterPlugin.FlutterPluginBinding) {
        context = b.applicationContext
        channel = MethodChannel(b.binaryMessenger, CHANNEL)
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(b: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
    }

    // ── Activity (needed for the unlock prompt and permission dialogs) ────────
    override fun onAttachedToActivity(b: ActivityPluginBinding) {
        activity = b.activity
        binding = b
        b.addRequestPermissionsResultListener(this)
    }

    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()
    override fun onReattachedToActivityForConfigChanges(b: ActivityPluginBinding) = onAttachedToActivity(b)
    override fun onDetachedFromActivity() {
        binding?.removeRequestPermissionsResultListener(this)
        binding = null
        activity = null
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
                        "screenLock" to deviceSecure(),
                    )
                )
                "sessionPublicKey" -> result.success(b64url(ensureSessionKey().public.encoded))
                "signWithSessionKey" -> {
                    val data = call.argument<ByteArray>("data") ?: return result.error("bad_args", "data missing", null)
                    ensureSessionKey()
                    result.success(sign(SESSION_ALIAS, data))
                }
                "resetSessionKey" -> {
                    keyStore().deleteEntry(SESSION_ALIAS)
                    result.success(null)
                }
                "createAttemptKey" -> {
                    val challenge = call.argument<ByteArray>("challenge") ?: return result.error("bad_args", "challenge missing", null)
                    createAttemptKey(challenge, result)
                }
                "attemptPublicKey" -> {
                    val cert = keyStore().getCertificate(ATTEMPT_ALIAS)
                    result.success(cert?.let { b64url(it.publicKey.encoded) })
                }
                "signWithAttemptKey" -> {
                    val data = call.argument<ByteArray>("data") ?: return result.error("bad_args", "data missing", null)
                    signWithAttempt(data, call.argument<String>("reason") ?: "Confirm it's you", result)
                }
                "unlockAttemptKey" -> unlock(call.argument<String>("reason") ?: "Confirm it's you") { ok, err ->
                    if (ok) result.success(true) else result.error("auth_cancelled", err ?: "Unlock cancelled", null)
                }
                "resetAttemptKey" -> {
                    keyStore().deleteEntry(ATTEMPT_ALIAS)
                    result.success(null)
                }
                "androidId" -> result.success(androidId())
                "locationFix" -> locationFix((call.argument<Int>("timeoutMs") ?: 10000).toLong(), result)
                "integrityToken" -> {
                    val project = (call.argument<Number>("cloudProjectNumber") ?: 0).toLong()
                    val hash = call.argument<String>("requestHash") ?: return result.error("bad_args", "requestHash missing", null)
                    integrityToken(project, hash, result)
                }
                else -> result.notImplemented()
            }
        } catch (e: Exception) {
            result.error("keystore_error", e.message ?: e.javaClass.simpleName, null)
        }
    }

    // ── Keys ──────────────────────────────────────────────────────────────────
    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun sign(alias: String, data: ByteArray): String {
        val sig = Signature.getInstance("SHA256withECDSA")
        sig.initSign(keyStore().getKey(alias, null) as PrivateKey)
        sig.update(data)
        return b64url(sig.sign())
    }

    private fun generate(alias: String, configure: (KeyGenParameterSpec.Builder) -> Unit): java.security.KeyPair {
        fun attempt(strongBox: Boolean): java.security.KeyPair {
            val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
            configure(builder)
            if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
            val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            gen.initialize(builder.build())
            return gen.generateKeyPair()
        }
        return if (hasStrongBox()) {
            try {
                attempt(true)
            } catch (e: StrongBoxUnavailableException) {
                attempt(false)
            }
        } else attempt(false)
    }

    /** Creates the session key once; later calls return the existing pair. */
    private fun ensureSessionKey(): java.security.KeyPair {
        val existing = keyStore().getEntry(SESSION_ALIAS, null) as? KeyStore.PrivateKeyEntry
        if (existing != null) return java.security.KeyPair(existing.certificate.publicKey, existing.privateKey)
        return generate(SESSION_ALIAS) {}
    }

    private fun createAttemptKey(challenge: ByteArray, result: Result) {
        if (!deviceSecure()) return result.error("no_screen_lock", "Set a screen lock (PIN, pattern or password) to use Argus.", null)
        keyStore().deleteEntry(ATTEMPT_ALIAS)
        generate(ATTEMPT_ALIAS) { b ->
            b.setUserAuthenticationRequired(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                b.setUserAuthenticationParameters(AUTH_WINDOW_S, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            } else {
                @Suppress("DEPRECATION")
                b.setUserAuthenticationValidityDurationSeconds(AUTH_WINDOW_S)
            }
            b.setAttestationChallenge(challenge)
        }
        val chain = keyStore().getCertificateChain(ATTEMPT_ALIAS)?.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) } ?: emptyList()
        val pub = keyStore().getCertificate(ATTEMPT_ALIAS).publicKey.encoded
        result.success(mapOf("publicKey" to b64url(pub), "chain" to chain))
    }

    /** Signs with the attempt key, asking the user to unlock first if the auth window has passed. */
    private fun signWithAttempt(data: ByteArray, reason: String, result: Result) {
        try {
            result.success(sign(ATTEMPT_ALIAS, data))
        } catch (e: UserNotAuthenticatedException) {
            unlock(reason) { ok, err ->
                if (!ok) return@unlock result.error("auth_cancelled", err ?: "Unlock cancelled", null)
                try {
                    result.success(sign(ATTEMPT_ALIAS, data))
                } catch (e2: Exception) {
                    result.error("keystore_error", e2.message ?: e2.javaClass.simpleName, null)
                }
            }
        } catch (e: java.security.InvalidKeyException) {
            // The key was invalidated (e.g. screen lock removed): the phone must be registered again.
            result.error("key_invalidated", "This phone's attendance key is no longer valid. Register the phone again.", null)
        }
    }

    private fun unlock(reason: String, done: (Boolean, String?) -> Unit) {
        val act = activity as? FragmentActivity ?: return done(false, "App is not in the foreground")
        val prompt = BiometricPrompt(act, ContextCompat.getMainExecutor(act), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) = done(true, null)
            override fun onAuthenticationError(code: Int, msg: CharSequence) = done(false, msg.toString())
        })
        val info = BiometricPrompt.PromptInfo.Builder().setTitle("Argus").setSubtitle(reason)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            info.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
        } else {
            @Suppress("DEPRECATION")
            info.setDeviceCredentialAllowed(true)
        }
        act.runOnUiThread { prompt.authenticate(info.build()) }
    }

    private fun deviceSecure(): Boolean = (context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceSecure

    /** StrongBox (a dedicated secure element) exists from Android 9 on some devices. */
    private fun hasStrongBox(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

    /** Stable per app-signing key, user and device; the server stores only a keyed hash (ADR-0009). */
    @SuppressLint("HardwareIds")
    private fun androidId(): String = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""

    // ── Location ─────────────────────────────────────────────────────────────
    private fun locationFix(timeoutMs: Long, result: Result) {
        withLocationPermission { fine, coarse ->
            if (!fine) return@withLocationPermission result.error(if (coarse) "precise_required" else "permission_denied", if (coarse) "Allow precise location for Argus." else "Allow location for Argus.", null)
            val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            if (!LocationManagerCompat.isLocationEnabled(lm)) return@withLocationPermission result.error("location_off", "Turn on location.", null)
            val cts = CancellationTokenSource()
            val req = CurrentLocationRequest.Builder()
                .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
                .setMaxUpdateAgeMillis(0) // a fresh fix, never a cached one
                .setDurationMillis(timeoutMs)
                .build()
            try {
                LocationServices.getFusedLocationProviderClient(context).getCurrentLocation(req, cts.token)
                    .addOnSuccessListener { loc: Location? ->
                        if (loc == null) result.error("timeout", "Could not get a location fix.", null) else result.success(locationMap(loc))
                    }
                    .addOnFailureListener { e -> result.error("location_error", e.message ?: "location error", null) }
            } catch (e: SecurityException) {
                result.error("permission_denied", "Allow location for Argus.", null)
            }
        }
    }

    private fun locationMap(loc: Location): Map<String, Any> {
        val ageMs = (SystemClock.elapsedRealtimeNanos() - loc.elapsedRealtimeNanos) / 1_000_000
        val mock = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) loc.isMock else @Suppress("DEPRECATION") loc.isFromMockProvider
        return mapOf("lat" to loc.latitude, "lon" to loc.longitude, "accuracyM" to loc.accuracy.toDouble(), "fixAgeMs" to ageMs, "isMock" to mock)
    }

    private fun withLocationPermission(then: (Boolean, Boolean) -> Unit) {
        val fine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (fine) return then(true, true)
        val act = activity ?: return then(false, false)
        pendingPermission = then
        ActivityCompat.requestPermissions(act, arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), REQ_LOCATION)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray): Boolean {
        if (requestCode != REQ_LOCATION) return false
        val granted = permissions.zip(grantResults.toTypedArray()).filter { it.second == PackageManager.PERMISSION_GRANTED }.map { it.first }
        val cb = pendingPermission
        pendingPermission = null
        cb?.invoke(Manifest.permission.ACCESS_FINE_LOCATION in granted, Manifest.permission.ACCESS_COARSE_LOCATION in granted)
        return true
    }

    // ── Play Integrity (standard request) ───────────────────────────────────
    private fun integrityToken(cloudProject: Long, requestHash: String, result: Result) {
        if (cloudProject <= 0) return result.error("integrity_unavailable", "Play Integrity is not configured in this build.", null)
        fun request(provider: StandardIntegrityTokenProvider) {
            provider.request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build())
                .addOnSuccessListener { t -> result.success(t.token()) }
                .addOnFailureListener { e ->
                    integrityProvider = null
                    result.error("integrity_unavailable", e.message ?: "Play Integrity error", null)
                }
        }
        val cached = integrityProvider
        if (cached != null && cached.first == cloudProject) return request(cached.second)
        IntegrityManagerFactory.createStandard(context)
            .prepareIntegrityToken(PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(cloudProject).build())
            .addOnSuccessListener { provider ->
                integrityProvider = cloudProject to provider
                request(provider)
            }
            .addOnFailureListener { e -> result.error("integrity_unavailable", e.message ?: "Play Integrity error", null) }
    }

    private fun b64url(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    companion object {
        const val CHANNEL = "argus/security"
        const val SESSION_ALIAS = "argus_session_v1"
        const val ATTEMPT_ALIAS = "argus_attempt_v1"
        const val AUTH_WINDOW_S = 60
        const val REQ_LOCATION = 0x4152
    }
}
