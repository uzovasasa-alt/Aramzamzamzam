package ru.agrocontrol.driver.location

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull
import ru.agrocontrol.driver.AgroApp
import ru.agrocontrol.driver.R
import ru.agrocontrol.driver.data.TrackPointEntity
import ru.agrocontrol.driver.ui.MainActivity

data class Fix(val lat: Double, val lon: Double, val accuracyM: Float, val gpsTimeMs: Long, val isMock: Boolean)

fun Location.toFix() = Fix(
    lat = latitude,
    lon = longitude,
    accuracyM = if (hasAccuracy()) accuracy else 9999f,
    gpsTimeMs = time,
    // Android сам сообщает, если координаты подставляет приложение «фейковый GPS»
    isMock = if (Build.VERSION.SDK_INT >= 31) isMock else @Suppress("DEPRECATION") isFromMockProvider,
)

object LocationHelper {
    /** Свежая точка с максимальной точностью. Ждём до 40 с — в поле GPS может «думать». */
    @SuppressLint("MissingPermission")
    suspend fun current(ctx: Context): Fix? {
        val client = LocationServices.getFusedLocationProviderClient(ctx)
        val cts = CancellationTokenSource()
        return withTimeoutOrNull(40_000) {
            client.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.token).await()?.toFix()
        }.also { if (it == null) cts.cancel() }
    }
}

/**
 * Фоновая запись трека, пока открыта смена (Foreground Service — Android не убьёт его,
 * а водитель видит уведомление «Идёт смена»). Точки пишутся в Room и уходят на сервер при синхронизации.
 */
class TrackingService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var callback: LocationCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    @SuppressLint("MissingPermission")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, notification(),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0,
        )
        if (callback == null) {
            val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 60_000)
                .setMinUpdateIntervalMillis(30_000)
                .setMinUpdateDistanceMeters(15f)
                .build()
            val cb = object : LocationCallback() {
                override fun onLocationResult(result: LocationResult) {
                    scope.launch { save(result.locations) }
                }
            }
            callback = cb
            runCatching {
                LocationServices.getFusedLocationProviderClient(this).requestLocationUpdates(req, cb, Looper.getMainLooper())
            }.onFailure { stopSelf() }
        }
        return START_STICKY
    }

    private suspend fun save(locations: List<Location>) {
        val db = AgroApp.get(this).db
        val shift = db.shifts().openShift()
        if (shift == null) {
            stopSelf()
            return
        }
        for (l in locations) {
            if (l.hasAccuracy() && l.accuracy > 200) continue // мусорные точки не пишем
            db.track().insert(
                TrackPointEntity(
                    shiftId = shift.id, ts = l.time, lat = l.latitude, lon = l.longitude,
                    accuracyM = if (l.hasAccuracy()) l.accuracy else null,
                    speedKmh = if (l.hasSpeed()) l.speed * 3.6f else null,
                ),
            )
            // Подмена GPS во время смены — тоже повод для модератора
            val fix = l.toFix()
            if (fix.isMock && !shift.mockLocation) {
                db.shifts().upsert(shift.copy(mockLocation = true, updatedAt = System.currentTimeMillis()))
            }
        }
    }

    override fun onDestroy() {
        callback?.let { LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(it) }
        scope.cancel()
        super.onDestroy()
    }

    private fun notification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Идёт смена", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Идёт смена")
            .setContentText("Маршрут записывается. Не забудьте закрыть смену на базе.")
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val CHANNEL = "tracking"
        private const val NOTIFICATION_ID = 42

        fun start(ctx: Context) = ContextCompat.startForegroundService(ctx, Intent(ctx, TrackingService::class.java))
        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, TrackingService::class.java))
    }
}
