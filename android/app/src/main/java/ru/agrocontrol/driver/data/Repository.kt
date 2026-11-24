package ru.agrocontrol.driver.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.provider.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.agrocontrol.driver.domain.GeoFence
import ru.agrocontrol.driver.domain.TrustedClock
import ru.agrocontrol.driver.location.Fix
import ru.agrocontrol.driver.sync.SyncWorker
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

/**
 * Все действия водителя. Каждое действие — только запись в локальную БД
 * и постановка синхронизации в очередь. Сеть здесь не нужна.
 */
class Repository(
    private val ctx: Context,
    val db: AppDatabase,
    val session: SessionStore,
    val clock: TrustedClock,
) {
    private val api get() = ApiFactory.create(session) // адрес сервера может поменяться — создаём по требованию

    val bootCount: Int
        get() = runCatching { Settings.Global.getInt(ctx.contentResolver, Settings.Global.BOOT_COUNT) }.getOrDefault(0)

    fun now(gpsTimeMs: Long? = null) = clock.now(bootCount, gpsTimeMs)

    /* ---------- Вход ---------- */

    suspend fun login(serverUrl: String, login: String, password: String) {
        session.serverUrl = serverUrl
        val r = api.login(LoginRequest(login.trim(), password))
        if (r.user.role != "DRIVER" && r.user.role != "ADMIN" && r.user.role != "MODERATOR") error("Эта учётная запись не для мобильного приложения")
        session.saveLogin(r)
        refreshReferences()
        SyncWorker.schedulePeriodic(ctx)
    }

    /** Справочники: техника, базы, настройки. Вызывается при входе и при каждой синхронизации. */
    suspend fun refreshReferences() {
        val b = api.bootstrap()
        clock.onServerTime(java.time.Instant.parse(b.serverTime).toEpochMilli(), bootCount)
        session.maxGpsAccuracyM = b.settings.maxGpsAccuracyM
        session.requireEndInZone = b.settings.requireEndInZone
        db.refs().replaceAll(
            b.vehicles.map { VehicleEntity(it.id, it.name, it.kind, it.regNumber, it.tankCapacityL, it.fuelNormLph, it.lastEngineHours, it.lastFuelL, it.hasSensors) },
            b.bases.map { BaseEntity(it.id, it.name, it.lat, it.lon, it.radiusM) },
        )
    }

    suspend fun logout() {
        session.markLoggedOut()
        SyncWorker.cancelAll(ctx)
    }

    /* ---------- Геозона ---------- */

    suspend fun checkZone(fix: Fix): GeoFence.Verdict {
        val zones = db.refs().bases().map { GeoFence.Zone(it.id, it.name, it.lat, it.lon, it.radiusM) }
        return GeoFence.check(fix.lat, fix.lon, fix.accuracyM, fix.isMock, zones, session.maxGpsAccuracyM)
    }

    /** Подсказка для водителя: последние известные показания техники (с сервера или из своих смен) */
    suspend fun lastKnown(vehicleId: String): Pair<Double?, Double?> {
        val local = db.shifts().lastClosedFor(vehicleId)
        val v = db.refs().vehicle(vehicleId)
        return Pair(local?.endEngineHours ?: v?.lastEngineHours, local?.endFuelL ?: v?.lastFuelL)
    }

    /* ---------- Смена ---------- */

    suspend fun startShift(
        shiftId: String, vehicle: VehicleEntity, fix: Fix, zone: GeoFence.Verdict.Inside,
        engineHours: Double, fuelL: Double, photos: List<PendingPhoto>,
    ) {
        val t = now(fix.gpsTimeMs)
        db.shifts().upsert(
            ShiftEntity(
                id = shiftId, vehicleId = vehicle.id, vehicleName = vehicle.name, baseId = zone.zone.id, baseName = zone.zone.name,
                startedAt = t, startLat = fix.lat, startLon = fix.lon, startAccuracyM = fix.accuracyM, mockLocation = fix.isMock,
                startEngineHours = engineHours, startFuelL = fuelL, updatedAt = System.currentTimeMillis(), serverStatus = "OPEN",
            ),
        )
        photos.forEach { savePhoto(it, shiftId = shiftId, refuelingId = null, fix = fix) }
        SyncWorker.requestNow(ctx)
    }

    suspend fun closeShift(shift: ShiftEntity, fix: Fix?, engineHours: Double, fuelL: Double, note: String?, photos: List<PendingPhoto>) {
        val t = now(fix?.gpsTimeMs).coerceAtLeast(shift.startedAt)
        db.shifts().upsert(
            shift.copy(
                endedAt = t, endLat = fix?.lat, endLon = fix?.lon, endAccuracyM = fix?.accuracyM,
                mockLocation = shift.mockLocation || (fix?.isMock ?: false),
                endEngineHours = engineHours, endFuelL = fuelL, driverNote = note?.takeIf { it.isNotBlank() },
                updatedAt = System.currentTimeMillis(), serverStatus = "CLOSED",
            ),
        )
        photos.forEach { savePhoto(it, shiftId = shift.id, refuelingId = null, fix = fix) }
        SyncWorker.requestNow(ctx)
    }

    suspend fun addRefuel(shift: ShiftEntity, liters: Double, note: String?, fix: Fix?, photo: PendingPhoto?) {
        val id = UUID.randomUUID().toString()
        db.refuels().upsert(
            RefuelEntity(
                id = id, vehicleId = shift.vehicleId, shiftId = shift.id, liters = liters, occurredAt = now(fix?.gpsTimeMs),
                lat = fix?.lat, lon = fix?.lon, note = note?.takeIf { it.isNotBlank() }, updatedAt = System.currentTimeMillis(),
            ),
        )
        photo?.let { savePhoto(it, shiftId = null, refuelingId = id, fix = fix) }
        SyncWorker.requestNow(ctx)
    }

    /* ---------- Фото ---------- */

    /** Снимок, сделанный камерой, но ещё не привязанный к смене (форма не сохранена) */
    data class PendingPhoto(val kind: String, val file: File, val takenAt: Long)

    fun newPhotoFile(): File {
        val dir = File(ctx.filesDir, "photos").apply { mkdirs() }
        return File(dir, "${UUID.randomUUID()}.jpg")
    }

    /**
     * Уменьшаем фото до 1600 px (чтобы уходило даже по EDGE), поворачиваем по EXIF
     * и считаем SHA-256 — сервер сверит хэш и поймёт, если файл подменили.
     */
    suspend fun processPhoto(kind: String, raw: File): PendingPhoto = withContext(Dispatchers.IO) {
        val takenAt = now()
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(raw.path, opts)
        var sample = 1
        while (maxOf(opts.outWidth, opts.outHeight) / sample > 3200) sample *= 2
        val src = BitmapFactory.decodeFile(raw.path, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: error("Не удалось прочитать снимок")
        val rotation = when (ExifInterface(raw.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
        val scale = minOf(1f, 1600f / maxOf(src.width, src.height))
        val m = Matrix().apply { postScale(scale, scale); postRotate(rotation) }
        val out = Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
        val dst = newPhotoFile()
        FileOutputStream(dst).use { out.compress(Bitmap.CompressFormat.JPEG, 82, it) }
        if (out !== src) out.recycle()
        src.recycle()
        raw.delete()
        PendingPhoto(kind, dst, takenAt)
    }

    private suspend fun savePhoto(p: PendingPhoto, shiftId: String?, refuelingId: String?, fix: Fix?) {
        db.photos().insert(
            PhotoEntity(
                id = UUID.randomUUID().toString(), kind = p.kind, shiftId = shiftId, refuelingId = refuelingId,
                filePath = p.file.path, takenAt = p.takenAt, lat = fix?.lat, lon = fix?.lon, sha256 = sha256(p.file),
            ),
        )
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
