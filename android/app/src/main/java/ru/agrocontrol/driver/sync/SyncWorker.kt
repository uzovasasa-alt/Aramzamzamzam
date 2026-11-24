package ru.agrocontrol.driver.sync

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import retrofit2.HttpException
import ru.agrocontrol.driver.AgroApp
import ru.agrocontrol.driver.data.ApiFactory
import ru.agrocontrol.driver.data.PhotoMetaDto
import ru.agrocontrol.driver.data.RefuelSyncDto
import ru.agrocontrol.driver.data.ShiftSyncDto
import ru.agrocontrol.driver.data.SyncRequest
import ru.agrocontrol.driver.data.TrackPointDto
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Фоновая синхронизация (WorkManager). Запускается:
 *  - сразу после любого действия водителя (если есть сеть — уйдёт за секунды);
 *  - раз в 15 минут на всякий случай;
 *  - WorkManager сам дождётся появления сети и повторит при ошибке с нарастающей паузой.
 *
 * Порядок важен: сначала смены и заправки, потом метаданные фото (ссылаются на них),
 * потом сами файлы фото, в конце — справочники.
 */
class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val app = AgroApp.get(applicationContext)
        val repo = app.repo
        if (repo.session.accessToken == null) return Result.success()
        val db = repo.db
        val api = ApiFactory.create(repo.session)
        return try {
            // 1. Пакет данных
            val shifts = db.shifts().pending()
            val refuels = db.refuels().pending()
            val photos = db.photos().pendingMeta()
            val track = db.track().oldest(3000)
            if (shifts.isNotEmpty() || refuels.isNotEmpty() || photos.isNotEmpty() || track.isNotEmpty()) {
                val req = SyncRequest(
                    deviceId = repo.session.deviceId,
                    shifts = shifts.map {
                        ShiftSyncDto(
                            id = it.id, vehicleId = it.vehicleId, startedAt = iso(it.startedAt), endedAt = it.endedAt?.let(::iso),
                            startLat = it.startLat, startLon = it.startLon, startAccuracyM = it.startAccuracyM,
                            endLat = it.endLat, endLon = it.endLon, endAccuracyM = it.endAccuracyM, mockLocation = it.mockLocation,
                            startEngineHours = it.startEngineHours, endEngineHours = it.endEngineHours,
                            startFuelL = it.startFuelL, endFuelL = it.endFuelL, driverNote = it.driverNote,
                            clientUpdatedAt = iso(it.updatedAt),
                        )
                    },
                    refuelings = refuels.map {
                        RefuelSyncDto(it.id, it.vehicleId, it.shiftId, it.liters, iso(it.occurredAt), it.lat, it.lon, it.note, iso(it.updatedAt))
                    },
                    photos = photos.map { PhotoMetaDto(it.id, it.kind, it.shiftId, it.refuelingId, iso(it.takenAt), it.lat, it.lon, it.sha256) },
                    trackPoints = track.map { TrackPointDto(it.shiftId, iso(it.ts), it.lat, it.lon, it.accuracyM, it.speedKmh) },
                )
                val res = api.sync(req)

                val sentShift = shifts.associateBy { it.id }
                for (r in res.shifts) {
                    val s = sentShift[r.id] ?: continue
                    when {
                        r.result == "ok" -> db.shifts().markSynced(r.id, s.updatedAt)
                        r.isRetry -> Unit
                        else -> db.shifts().markError(r.id, r.reason ?: "Отклонено сервером")
                    }
                }
                val sentRefuel = refuels.associateBy { it.id }
                for (r in res.refuelings) {
                    val s = sentRefuel[r.id] ?: continue
                    when {
                        r.result == "ok" -> db.refuels().markSynced(r.id, s.updatedAt)
                        r.isRetry -> Unit
                        else -> db.refuels().markError(r.id, r.reason ?: "Отклонено сервером")
                    }
                }
                for (r in res.photos) {
                    when {
                        r.result == "ok" -> db.photos().markMetaSynced(r.id)
                        r.isRetry -> Unit
                        else -> db.photos().markError(r.id, r.reason ?: "Отклонено сервером")
                    }
                }
                // Точки трека удаляем только по сменам, которые сервер принял
                val accepted = res.trackShiftsAccepted.toSet()
                db.track().delete(track.filter { it.shiftId in accepted }.map { it.pk })
                for (st in res.shiftStates) db.shifts().applyServerState(st.id, st.status, st.reviewComment, st.anomalyCount)
            }

            // 2. Файлы фото
            for (p in db.photos().pendingUpload()) {
                val f = File(p.filePath)
                if (!f.exists()) { db.photos().markError(p.id, "Файл фото потерян"); continue }
                val part = MultipartBody.Part.createFormData("file", f.name, f.asRequestBody("image/jpeg".toMediaType()))
                val r = api.uploadPhoto(p.id, part)
                when {
                    r.isSuccessful -> { db.photos().markUploaded(p.id); f.delete() }
                    r.code() == 404 -> Unit // метаданные ещё не дошли — в следующий раз
                    r.code() in 400..499 -> db.photos().markError(p.id, "Сервер отклонил фото (${r.code()})")
                    else -> throw IOException("HTTP ${r.code()}")
                }
            }

            // 3. Справочники и время сервера
            repo.refreshReferences()
            repo.session.markSynced(System.currentTimeMillis())

            // Если трек не влез в один пакет — сразу ещё раз
            if (db.track().oldest(1).isNotEmpty() && track.size >= 3000) requestNow(applicationContext)
            Result.success()
        } catch (e: HttpException) {
            Log.w(TAG, "HTTP ${e.code()}", e)
            if (e.code() == 401) { repo.session.markLoggedOut(); Result.failure() } else Result.retry()
        } catch (e: IOException) {
            Log.i(TAG, "Нет связи: ${e.message}")
            Result.retry()
        } catch (e: Exception) {
            Log.e(TAG, "Ошибка синхронизации", e)
            Result.retry()
        }
    }

    private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

    companion object {
        private const val TAG = "SyncWorker"
        private const val NOW = "sync-now"
        private const val PERIODIC = "sync-periodic"
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun requestNow(ctx: Context) {
            val req = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(online)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            // APPEND_OR_REPLACE: если синхронизация уже идёт, следующая начнётся сразу после неё
            WorkManager.getInstance(ctx).enqueueUniqueWork(NOW, ExistingWorkPolicy.APPEND_OR_REPLACE, req)
        }

        fun schedulePeriodic(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun cancelAll(ctx: Context) {
            WorkManager.getInstance(ctx).cancelUniqueWork(NOW)
            WorkManager.getInstance(ctx).cancelUniqueWork(PERIODIC)
        }
    }
}
