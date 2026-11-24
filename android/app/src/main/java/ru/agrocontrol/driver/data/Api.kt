package ru.agrocontrol.driver.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Authenticator
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Route
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Part
import retrofit2.http.Path
import ru.agrocontrol.driver.BuildConfig
import java.util.concurrent.TimeUnit

/* ---------- DTO: соответствуют backend/src/mobile/sync.dto.ts ---------- */

@Serializable data class LoginRequest(val login: String, val password: String)
@Serializable data class RefreshRequest(val refreshToken: String)
@Serializable data class UserDto(val id: String, val orgId: String? = null, val role: String, val fullName: String)
@Serializable data class LoginResponse(val accessToken: String, val refreshToken: String, val user: UserDto)

@Serializable data class VehicleDto(
    val id: String, val name: String, val kind: String, val regNumber: String? = null, val tankCapacityL: Double,
    val fuelNormLph: Double? = null, val lastEngineHours: Double? = null, val lastFuelL: Double? = null, val hasSensors: Boolean = false,
)
@Serializable data class BaseDto(val id: String, val name: String, val lat: Double, val lon: Double, val radiusM: Int)
@Serializable data class SettingsDto(val maxGpsAccuracyM: Int = 100, val requireEndInZone: Boolean = false)
@Serializable data class BootstrapResponse(
    val serverTime: String, val user: UserDto, val settings: SettingsDto, val bases: List<BaseDto>, val vehicles: List<VehicleDto>,
)

@Serializable data class ShiftSyncDto(
    val id: String, val vehicleId: String, val startedAt: String, val endedAt: String? = null,
    val startLat: Double, val startLon: Double, val startAccuracyM: Float,
    val endLat: Double? = null, val endLon: Double? = null, val endAccuracyM: Float? = null,
    val mockLocation: Boolean, val startEngineHours: Double, val endEngineHours: Double? = null,
    val startFuelL: Double, val endFuelL: Double? = null, val driverNote: String? = null, val clientUpdatedAt: String,
)
@Serializable data class RefuelSyncDto(
    val id: String, val vehicleId: String, val shiftId: String? = null, val liters: Double, val occurredAt: String,
    val lat: Double? = null, val lon: Double? = null, val note: String? = null, val clientUpdatedAt: String,
)
@Serializable data class PhotoMetaDto(
    val id: String, val kind: String, val shiftId: String? = null, val refuelingId: String? = null, val takenAt: String,
    val lat: Double? = null, val lon: Double? = null, val sha256: String,
)
@Serializable data class TrackPointDto(
    val shiftId: String, val ts: String, val lat: Double, val lon: Double, val accuracyM: Float? = null, val speedKmh: Float? = null,
)
@Serializable data class SyncRequest(
    val deviceId: String, val shifts: List<ShiftSyncDto>, val refuelings: List<RefuelSyncDto>,
    val photos: List<PhotoMetaDto>, val trackPoints: List<TrackPointDto>,
)
@Serializable data class ItemResult(val id: String, val result: String, val reason: String? = null) {
    /** «RETRY:» — временная ситуация (например, смена ещё не дошла), повторим при следующей синхронизации */
    val isRetry get() = result == "rejected" && reason?.startsWith("RETRY") == true
}
@Serializable data class ShiftState(
    val id: String, val status: String, val reviewComment: String? = null, val anomalyCount: Int = 0,
)
@Serializable data class SyncResponse(
    val serverTime: String, val shifts: List<ItemResult>, val refuelings: List<ItemResult>, val photos: List<ItemResult>,
    val trackShiftsAccepted: List<String> = emptyList(), val shiftStates: List<ShiftState> = emptyList(),
)

interface AgroApi {
    @POST("api/auth/login") suspend fun login(@Body body: LoginRequest): LoginResponse
    @GET("api/mobile/bootstrap") suspend fun bootstrap(): BootstrapResponse
    @POST("api/mobile/sync") suspend fun sync(@Body body: SyncRequest): SyncResponse

    @Multipart
    @PUT("api/mobile/photos/{id}")
    suspend fun uploadPhoto(@Path("id") id: String, @Part file: MultipartBody.Part): retrofit2.Response<Unit>
}

val AppJson = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

object ApiFactory {
    fun create(session: SessionStore): AgroApi {
        val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS) // фото по слабому 3G
            .addInterceptor { chain ->
                val token = session.accessToken
                val req = if (token != null) chain.request().newBuilder().header("Authorization", "Bearer $token").build() else chain.request()
                chain.proceed(req)
            }
            .authenticator(TokenRefresher(session))
            .apply {
                if (BuildConfig.DEBUG) addInterceptor(HttpLoggingInterceptor().setLevel(HttpLoggingInterceptor.Level.BASIC))
            }
            .build()
        return Retrofit.Builder()
            .baseUrl(session.serverUrl.trimEnd('/') + "/")
            .client(client)
            .addConverterFactory(AppJson.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(AgroApi::class.java)
    }
}

/** При 401 обновляет access-токен по refresh-токену и повторяет запрос (один раз). */
private class TokenRefresher(private val session: SessionStore) : Authenticator {
    private val plain = OkHttpClient()

    @Synchronized
    override fun authenticate(route: Route?, response: Response): Request? {
        if (response.request.url.encodedPath.endsWith("/auth/login")) return null
        if (response.priorResponse != null) return null // уже пробовали
        val failedToken = response.request.header("Authorization")?.removePrefix("Bearer ")
        // Другой поток уже обновил токен, пока мы ждали
        if (session.accessToken != null && session.accessToken != failedToken) {
            return response.request.newBuilder().header("Authorization", "Bearer ${session.accessToken}").build()
        }
        val refresh = session.refreshToken ?: return null
        val body = AppJson.encodeToString(RefreshRequest.serializer(), RefreshRequest(refresh))
            .toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url(session.serverUrl.trimEnd('/') + "/api/auth/refresh").post(body).build()
        return try {
            plain.newCall(req).execute().use { r ->
                if (!r.isSuccessful) {
                    if (r.code == 401) session.markLoggedOut()
                    return null
                }
                val s = AppJson.decodeFromString(LoginResponse.serializer(), r.body!!.string())
                session.saveLogin(s)
                response.request.newBuilder().header("Authorization", "Bearer ${s.accessToken}").build()
            }
        } catch (e: Exception) {
            null
        }
    }
}
