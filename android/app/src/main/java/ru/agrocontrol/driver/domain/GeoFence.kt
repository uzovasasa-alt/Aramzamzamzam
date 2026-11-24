package ru.agrocontrol.driver.domain

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Проверка «водитель на базе?» — та же логика, что на сервере (backend/src/domain/geo.ts).
 * Телефон решает сам, чтобы работать без связи; сервер потом перепроверяет через PostGIS.
 */
object GeoFence {
    private const val EARTH_RADIUS_M = 6_371_008.8

    data class Zone(val id: String, val name: String, val lat: Double, val lon: Double, val radiusM: Int)

    sealed interface Verdict {
        val distanceM: Double
        data class Inside(val zone: Zone, override val distanceM: Double) : Verdict
        data class Outside(val nearest: Zone?, override val distanceM: Double) : Verdict
        data class LowAccuracy(val accuracyM: Float, val maxM: Int, override val distanceM: Double) : Verdict
        data class Mock(override val distanceM: Double) : Verdict
        data object NoZones : Verdict { override val distanceM = Double.NaN }
    }

    fun distanceM(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        fun rad(d: Double) = Math.toRadians(d)
        val dLat = rad(lat2 - lat1)
        val dLon = rad(lon2 - lon1)
        val h = sin(dLat / 2) * sin(dLat / 2) + cos(rad(lat1)) * cos(rad(lat2)) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(h)))
    }

    /**
     * Точность GPS не прибавляется к радиусу — иначе при плохом сигнале зона «раздувается».
     * Неточную фиксацию просто отклоняем и просим подождать.
     */
    fun check(lat: Double, lon: Double, accuracyM: Float, isMock: Boolean, zones: List<Zone>, maxAccuracyM: Int): Verdict {
        if (zones.isEmpty()) return Verdict.NoZones
        val nearest = zones.minBy { distanceM(lat, lon, it.lat, it.lon) - it.radiusM }
        val d = distanceM(lat, lon, nearest.lat, nearest.lon)
        if (isMock) return Verdict.Mock(d)
        if (accuracyM > maxAccuracyM) return Verdict.LowAccuracy(accuracyM, maxAccuracyM, d)
        return if (d <= nearest.radiusM) Verdict.Inside(nearest, d) else Verdict.Outside(nearest, d - nearest.radiusM)
    }
}
