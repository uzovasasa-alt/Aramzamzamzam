package ru.agrocontrol.driver.domain

import android.os.SystemClock

/**
 * «Честное» время, которое нельзя подкрутить в настройках телефона.
 *
 * При каждой синхронизации запоминаем время сервера и монотонные часы телефона
 * (elapsedRealtime — они идут с момента включения и не зависят от настроек даты).
 * Дальше текущее время = время сервера + сколько прошло по монотонным часам.
 * После перезагрузки телефона якорь теряется — тогда берём время GPS-фиксации
 * (его даёт спутник) или, в крайнем случае, системное.
 */
class TrustedClock(private val store: AnchorStore) {

    interface AnchorStore {
        var serverTimeMs: Long
        var elapsedAtSyncMs: Long
        var bootCount: Int
    }

    fun onServerTime(serverTimeMs: Long, bootCount: Int) {
        store.serverTimeMs = serverTimeMs
        store.elapsedAtSyncMs = SystemClock.elapsedRealtime()
        store.bootCount = bootCount
    }

    /** null, если надёжного якоря нет (телефон перезагружался после последней синхронизации) */
    fun anchoredNow(currentBootCount: Int): Long? {
        if (store.serverTimeMs == 0L || store.bootCount != currentBootCount) return null
        val elapsed = SystemClock.elapsedRealtime() - store.elapsedAtSyncMs
        if (elapsed < 0) return null
        return store.serverTimeMs + elapsed
    }

    /** Лучшее доступное время: якорь сервера → время GPS → системное. */
    fun now(currentBootCount: Int, gpsTimeMs: Long? = null): Long =
        anchoredNow(currentBootCount) ?: gpsTimeMs ?: System.currentTimeMillis()

    /** Часы телефона расходятся с «честными» больше чем на 5 минут — водителю стоит знать, а модератору — видеть. */
    fun isSystemClockSuspicious(currentBootCount: Int): Boolean {
        val t = anchoredNow(currentBootCount) ?: return false
        return kotlin.math.abs(System.currentTimeMillis() - t) > 5 * 60_000
    }
}
