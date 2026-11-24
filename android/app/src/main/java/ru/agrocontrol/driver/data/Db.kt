package ru.agrocontrol.driver.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/*
 * Локальная БД (Room). Всё, что вводит водитель, сначала пишется сюда — приложение
 * полностью работает без связи. Поле syncedVersion хранит, какую версию записи
 * (updatedAt) сервер уже подтвердил: если они не равны — запись ждёт отправки.
 */

@Entity(tableName = "shifts")
data class ShiftEntity(
    @PrimaryKey val id: String,
    val vehicleId: String,
    val vehicleName: String,
    val baseId: String?,
    val baseName: String?,
    val startedAt: Long,
    val endedAt: Long? = null,
    val startLat: Double,
    val startLon: Double,
    val startAccuracyM: Float,
    val endLat: Double? = null,
    val endLon: Double? = null,
    val endAccuracyM: Float? = null,
    val mockLocation: Boolean = false,
    val startEngineHours: Double,
    val endEngineHours: Double? = null,
    val startFuelL: Double,
    val endFuelL: Double? = null,
    val driverNote: String? = null,
    val updatedAt: Long,
    val syncedVersion: Long = 0,
    val syncError: String? = null,
    /** Статус на сервере: OPEN / CLOSED / APPROVED / REJECTED */
    val serverStatus: String? = null,
    val reviewComment: String? = null,
    val anomalyCount: Int = 0,
)

// Вычисляемые свойства — расширения, чтобы Room не пытался сохранить их в таблицу
val ShiftEntity.isOpen get() = endedAt == null
val ShiftEntity.isPending get() = syncedVersion != updatedAt

@Entity(tableName = "refuelings", indices = [Index("shiftId")])
data class RefuelEntity(
    @PrimaryKey val id: String,
    val vehicleId: String,
    val shiftId: String?,
    val liters: Double,
    val occurredAt: Long,
    val lat: Double?,
    val lon: Double?,
    val note: String?,
    val updatedAt: Long,
    val syncedVersion: Long = 0,
    val syncError: String? = null,
)

val RefuelEntity.isPending get() = syncedVersion != updatedAt

@Entity(tableName = "photos", indices = [Index("shiftId"), Index("refuelingId")])
data class PhotoEntity(
    @PrimaryKey val id: String,
    val kind: String,
    val shiftId: String?,
    val refuelingId: String?,
    val filePath: String,
    val takenAt: Long,
    val lat: Double?,
    val lon: Double?,
    val sha256: String,
    val metaSynced: Boolean = false,
    val uploaded: Boolean = false,
    val error: String? = null,
)

@Entity(tableName = "track_points", indices = [Index("shiftId")])
data class TrackPointEntity(
    @PrimaryKey(autoGenerate = true) val pk: Long = 0,
    val shiftId: String,
    val ts: Long,
    val lat: Double,
    val lon: Double,
    val accuracyM: Float?,
    val speedKmh: Float?,
)

@Entity(tableName = "vehicles")
data class VehicleEntity(
    @PrimaryKey val id: String,
    val name: String,
    val kind: String,
    val regNumber: String?,
    val tankCapacityL: Double,
    val fuelNormLph: Double?,
    val lastEngineHours: Double?,
    val lastFuelL: Double?,
    val hasSensors: Boolean,
)

@Entity(tableName = "bases")
data class BaseEntity(
    @PrimaryKey val id: String,
    val name: String,
    val lat: Double,
    val lon: Double,
    val radiusM: Int,
)

@Dao
interface ShiftDao {
    @Query("SELECT * FROM shifts WHERE endedAt IS NULL ORDER BY startedAt DESC LIMIT 1")
    fun openShiftFlow(): Flow<ShiftEntity?>

    @Query("SELECT * FROM shifts WHERE endedAt IS NULL ORDER BY startedAt DESC LIMIT 1")
    suspend fun openShift(): ShiftEntity?

    @Query("SELECT * FROM shifts ORDER BY startedAt DESC LIMIT 60")
    fun historyFlow(): Flow<List<ShiftEntity>>

    @Query("SELECT * FROM shifts WHERE id = :id")
    suspend fun get(id: String): ShiftEntity?

    @Query("SELECT * FROM shifts WHERE syncedVersion != updatedAt")
    suspend fun pending(): List<ShiftEntity>

    @Upsert suspend fun upsert(s: ShiftEntity)

    /** Отмечаем отправленным, только если запись не менялась, пока шла синхронизация */
    @Query("UPDATE shifts SET syncedVersion = :version, syncError = NULL WHERE id = :id AND updatedAt = :version")
    suspend fun markSynced(id: String, version: Long)

    @Query("UPDATE shifts SET syncError = :error WHERE id = :id")
    suspend fun markError(id: String, error: String)

    @Query("UPDATE shifts SET serverStatus = :status, reviewComment = :comment, anomalyCount = :anomalies WHERE id = :id")
    suspend fun applyServerState(id: String, status: String, comment: String?, anomalies: Int)

    @Query("SELECT * FROM shifts WHERE vehicleId = :vehicleId AND endedAt IS NOT NULL ORDER BY endedAt DESC LIMIT 1")
    suspend fun lastClosedFor(vehicleId: String): ShiftEntity?
}

@Dao
interface RefuelDao {
    @Query("SELECT * FROM refuelings WHERE shiftId = :shiftId ORDER BY occurredAt")
    fun forShiftFlow(shiftId: String): Flow<List<RefuelEntity>>

    @Query("SELECT * FROM refuelings WHERE shiftId = :shiftId")
    suspend fun forShift(shiftId: String): List<RefuelEntity>

    @Query("SELECT * FROM refuelings WHERE syncedVersion != updatedAt")
    suspend fun pending(): List<RefuelEntity>

    @Upsert suspend fun upsert(r: RefuelEntity)

    @Query("UPDATE refuelings SET syncedVersion = :version, syncError = NULL WHERE id = :id AND updatedAt = :version")
    suspend fun markSynced(id: String, version: Long)

    @Query("UPDATE refuelings SET syncError = :error WHERE id = :id")
    suspend fun markError(id: String, error: String)
}

@Dao
interface PhotoDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insert(p: PhotoEntity)

    @Query("SELECT * FROM photos WHERE shiftId = :shiftId")
    fun forShiftFlow(shiftId: String): Flow<List<PhotoEntity>>

    @Query("SELECT * FROM photos WHERE metaSynced = 0")
    suspend fun pendingMeta(): List<PhotoEntity>

    @Query("SELECT * FROM photos WHERE metaSynced = 1 AND uploaded = 0 AND error IS NULL")
    suspend fun pendingUpload(): List<PhotoEntity>

    @Query("UPDATE photos SET metaSynced = 1 WHERE id = :id") suspend fun markMetaSynced(id: String)
    @Query("UPDATE photos SET uploaded = 1, error = NULL WHERE id = :id") suspend fun markUploaded(id: String)
    @Query("UPDATE photos SET error = :error WHERE id = :id") suspend fun markError(id: String, error: String)
    @Query("DELETE FROM photos WHERE id = :id") suspend fun delete(id: String)
}

@Dao
interface TrackDao {
    @Insert suspend fun insert(p: TrackPointEntity)

    @Query("SELECT * FROM track_points ORDER BY ts LIMIT :limit")
    suspend fun oldest(limit: Int): List<TrackPointEntity>

    @Query("DELETE FROM track_points WHERE pk IN (:ids)")
    suspend fun delete(ids: List<Long>)

    @Query("SELECT count(*) FROM track_points")
    fun countFlow(): Flow<Int>
}

@Dao
abstract class RefDao {
    @Query("SELECT * FROM vehicles ORDER BY name") abstract fun vehiclesFlow(): Flow<List<VehicleEntity>>
    @Query("SELECT * FROM vehicles WHERE id = :id") abstract suspend fun vehicle(id: String): VehicleEntity?
    @Query("SELECT * FROM bases") abstract suspend fun bases(): List<BaseEntity>
    @Query("SELECT * FROM bases") abstract fun basesFlow(): Flow<List<BaseEntity>>

    @Query("DELETE FROM vehicles") protected abstract suspend fun clearVehicles()
    @Query("DELETE FROM bases") protected abstract suspend fun clearBases()
    @Insert(onConflict = OnConflictStrategy.REPLACE) protected abstract suspend fun insertVehicles(v: List<VehicleEntity>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) protected abstract suspend fun insertBases(b: List<BaseEntity>)

    @Transaction
    open suspend fun replaceAll(vehicles: List<VehicleEntity>, bases: List<BaseEntity>) {
        clearVehicles(); insertVehicles(vehicles)
        clearBases(); insertBases(bases)
    }
}

/** Сводка очереди для экрана: сколько ещё не отправлено */
@Dao
interface QueueDao {
    @Query(
        """SELECT (SELECT count(*) FROM shifts WHERE syncedVersion != updatedAt)
                + (SELECT count(*) FROM refuelings WHERE syncedVersion != updatedAt)
                + (SELECT count(*) FROM photos WHERE uploaded = 0 AND error IS NULL)"""
    )
    fun pendingCountFlow(): Flow<Int>
}

@Database(
    entities = [ShiftEntity::class, RefuelEntity::class, PhotoEntity::class, TrackPointEntity::class, VehicleEntity::class, BaseEntity::class],
    version = 1,
    exportSchema = true,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun shifts(): ShiftDao
    abstract fun refuels(): RefuelDao
    abstract fun photos(): PhotoDao
    abstract fun track(): TrackDao
    abstract fun refs(): RefDao
    abstract fun queue(): QueueDao

    companion object {
        fun create(ctx: Context) = Room.databaseBuilder(ctx, AppDatabase::class.java, "agro.db").build()
    }
}
