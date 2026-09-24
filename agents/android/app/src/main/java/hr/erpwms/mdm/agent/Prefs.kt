package hr.erpwms.mdm.agent

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Postavke agenta u privatnim SharedPreferences. Tajni ključ uređaja (token)
 * šifriran je AES-GCM ključem iz Android Keystorea (ključ ne napušta uređaj);
 * ako Keystore nije dostupan (rijetki uređaji), token se sprema nešifriran u
 * privatnu datoteku aplikacije (vidljivu samo aplikaciji/rootu).
 */
class Prefs(ctx: Context) {
    private val sp: SharedPreferences = ctx.applicationContext.getSharedPreferences("agent", Context.MODE_PRIVATE)

    var server: String?
        get() = sp.getString("server", null)
        set(v) = sp.edit().putString("server", v).apply()
    var enrollToken: String?
        get() = sp.getString("enrollToken", null)
        set(v) = sp.edit().putString("enrollToken", v).apply()
    var deviceId: String?
        get() = sp.getString("deviceId", null)
        set(v) = sp.edit().putString("deviceId", v).apply()
    var token: String?
        get() = sp.getString("token", null)?.let { decrypt(it) }
        set(v) = sp.edit().putString("token", v?.let { encrypt(it) }).apply()
    var status: String
        get() = sp.getString("status", "NEW") ?: "NEW"
        set(v) = sp.edit().putString("status", v).apply()
    var enrollCode: String?
        get() = sp.getString("enrollCode", null)
        set(v) = sp.edit().putString("enrollCode", v).apply()
    var deviceName: String?
        get() = sp.getString("deviceName", null)
        set(v) = sp.edit().putString("deviceName", v).apply()
    var checkinSec: Int
        get() = sp.getInt("checkinSec", 60)
        set(v) = sp.edit().putInt("checkinSec", v).apply()
    var appliedConfigVersion: Int
        get() = sp.getInt("appliedConfigVersion", 0)
        set(v) = sp.edit().putInt("appliedConfigVersion", v).apply()
    var lastConfig: String?
        get() = sp.getString("lastConfig", null)
        set(v) = sp.edit().putString("lastConfig", v).apply()
    var hiddenPackages: Set<String>
        get() = sp.getStringSet("hidden", emptySet())?.toSet() ?: emptySet()
        set(v) = sp.edit().putStringSet("hidden", v).apply()
    var lastCheckinAt: Long
        get() = sp.getLong("lastCheckinAt", 0)
        set(v) = sp.edit().putLong("lastCheckinAt", v).apply()
    var lastError: String?
        get() = sp.getString("lastError", null)
        set(v) = sp.edit().putString("lastError", v).apply()
    var failures: Int
        get() = sp.getInt("failures", 0)
        set(v) = sp.edit().putInt("failures", v).apply()
    var kioskEnabled: Boolean
        get() = sp.getBoolean("kiosk", false)
        set(v) = sp.edit().putBoolean("kiosk", v).apply()
    var kioskPackage: String?
        get() = sp.getString("kioskPackage", null)
        set(v) = sp.edit().putString("kioskPackage", v).apply()
    var maintenancePin: String?
        get() = sp.getString("maintenancePin", null)
        set(v) = sp.edit().putString("maintenancePin", v).apply()

    val isRegistered get() = token != null && server != null

    /** Briše vjerodajnice i stanje upisa (FORGET, HTTP 410). Adresa poslužitelja ostaje. */
    fun clearCredentials() {
        sp.edit().remove("deviceId").remove("token").remove("enrollCode").remove("deviceName")
            .remove("appliedConfigVersion").remove("lastConfig").remove("enrollToken").remove("failures")
            .remove("maintenancePin").putString("status", "NEW").apply()
    }

    fun changeListener(l: SharedPreferences.OnSharedPreferenceChangeListener) = sp.registerOnSharedPreferenceChangeListener(l)
    fun removeListener(l: SharedPreferences.OnSharedPreferenceChangeListener) = sp.unregisterOnSharedPreferenceChangeListener(l)

    // ------------------------------------------------------------ šifriranje tokena

    private fun key(): SecretKey? = try {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    } catch (e: Exception) {
        AgentLog.w("prefs", "Keystore nije dostupan", e)
        null
    }

    private fun encrypt(plain: String): String {
        val k = key() ?: return "p:$plain"
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, k)
            val ct = c.doFinal(plain.toByteArray(Charsets.UTF_8))
            "k:" + Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
        } catch (e: Exception) {
            AgentLog.w("prefs", "Šifriranje nije uspjelo", e)
            "p:$plain"
        }
    }

    private fun decrypt(stored: String): String? {
        if (stored.startsWith("p:")) return stored.substring(2)
        if (!stored.startsWith("k:")) return null
        val parts = stored.split(":")
        if (parts.size != 3) return null
        return try {
            val k = key() ?: return null
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, Base64.decode(parts[1], Base64.NO_WRAP)))
            String(c.doFinal(Base64.decode(parts[2], Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            AgentLog.e("prefs", "Token se ne može dešifrirati", e)
            null
        }
    }

    companion object {
        private const val ALIAS = "erpwms_agent_token"
    }
}
