package ru.agrocontrol.driver.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import ru.agrocontrol.driver.BuildConfig
import ru.agrocontrol.driver.domain.TrustedClock
import java.util.UUID

/**
 * Настройки и сессия водителя в SharedPreferences.
 * Токены живут здесь же: refresh-токен действует 60 дней, поэтому водитель
 * может неделю работать в поле без связи и не «вылетит» из приложения.
 */
class SessionStore(ctx: Context) : TrustedClock.AnchorStore {
    private val p = ctx.getSharedPreferences("agro.session", Context.MODE_PRIVATE)

    private val _user = MutableStateFlow(loadUser())
    val user: StateFlow<UserDto?> = _user

    private val _lastSyncAt = MutableStateFlow(p.getLong("lastSyncAt", 0))
    val lastSyncAt: StateFlow<Long> = _lastSyncAt

    var serverUrl: String
        get() = p.getString("serverUrl", null) ?: BuildConfig.DEFAULT_SERVER
        set(v) = p.edit().putString("serverUrl", v.trim()).apply()

    val accessToken: String? get() = p.getString("access", null)
    val refreshToken: String? get() = p.getString("refresh", null)

    /** Постоянный id установки — помогает модератору понять, с какого телефона пришли данные */
    val deviceId: String
        get() = p.getString("deviceId", null) ?: UUID.randomUUID().toString().also { p.edit().putString("deviceId", it).apply() }

    var maxGpsAccuracyM: Int
        get() = p.getInt("maxGpsAccuracyM", 100)
        set(v) = p.edit().putInt("maxGpsAccuracyM", v).apply()

    var requireEndInZone: Boolean
        get() = p.getBoolean("requireEndInZone", false)
        set(v) = p.edit().putBoolean("requireEndInZone", v).apply()

    fun saveLogin(r: LoginResponse) {
        p.edit()
            .putString("access", r.accessToken)
            .putString("refresh", r.refreshToken)
            .putString("user", AppJson.encodeToString(UserDto.serializer(), r.user))
            .apply()
        _user.value = r.user
    }

    fun markLoggedOut() {
        p.edit().remove("access").remove("refresh").remove("user").apply()
        _user.value = null
    }

    fun markSynced(at: Long) {
        p.edit().putLong("lastSyncAt", at).apply()
        _lastSyncAt.value = at
    }

    private fun loadUser(): UserDto? = p.getString("user", null)?.let {
        runCatching { AppJson.decodeFromString(UserDto.serializer(), it) }.getOrNull()
    }

    // --- якорь «честного» времени (см. TrustedClock) ---
    override var serverTimeMs: Long
        get() = p.getLong("anchorServer", 0)
        set(v) = p.edit().putLong("anchorServer", v).apply()
    override var elapsedAtSyncMs: Long
        get() = p.getLong("anchorElapsed", 0)
        set(v) = p.edit().putLong("anchorElapsed", v).apply()
    override var bootCount: Int
        get() = p.getInt("anchorBoot", -1)
        set(v) = p.edit().putInt("anchorBoot", v).apply()
}
