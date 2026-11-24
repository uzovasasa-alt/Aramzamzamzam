package ru.agrocontrol.driver.ui

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.launch
import ru.agrocontrol.driver.AgroApp
import ru.agrocontrol.driver.data.Repository
import ru.agrocontrol.driver.domain.GeoFence
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

fun parseNumber(s: String): Double? = s.trim().replace(',', '.').replace(" ", "").toDoubleOrNull()

fun fmtNum(v: Double?, digits: Int = 1): String =
    if (v == null) "—" else String.format(Locale("ru"), "%.${digits}f", v).removeSuffix(",0")

fun fmtTime(ms: Long): String = SimpleDateFormat("HH:mm", Locale("ru")).format(Date(ms))
fun fmtDateTime(ms: Long): String = SimpleDateFormat("d MMM, HH:mm", Locale("ru")).format(Date(ms))

@Composable
fun NumberField(label: String, value: String, onChange: (String) -> Unit, hint: String? = null, error: String? = null) {
    OutlinedTextField(
        value = value,
        onValueChange = { s -> onChange(s.filter { it.isDigit() || it == ',' || it == '.' }) },
        label = { Text(label) },
        singleLine = true,
        isError = error != null,
        supportingText = (error ?: hint)?.let { t -> { Text(t, color = if (error != null) AgroColors.Alert else AgroColors.Ink3) } },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        textStyle = MaterialTheme.typography.titleLarge,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
fun Card(modifier: Modifier = Modifier, tone: Color = Color.White, content: @Composable () -> Unit) {
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(tone)
            .border(1.dp, AgroColors.Line, RoundedCornerShape(12.dp))
            .padding(16.dp),
    ) { content() }
}

/**
 * Кнопка «сфотографировать показания»: открывает системную камеру, после снимка
 * показывает миниатюру. Повторное нажатие — переснять.
 */
@Composable
fun PhotoCapture(label: String, kind: String, photo: Repository.PendingPhoto?, onPhoto: (Repository.PendingPhoto) -> Unit) {
    val ctx = LocalContext.current
    val repo = AgroApp.get(ctx).repo
    val scope = rememberCoroutineScope()
    var pendingPath by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val path = pendingPath
        if (ok && path != null) {
            busy = true
            scope.launch {
                runCatching { repo.processPhoto(kind, File(path)) }.onSuccess(onPhoto)
                busy = false
            }
        }
    }
    val thumb = remember(photo?.file?.path) {
        photo?.file?.let { f -> BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = 8 })?.asImageBitmap() }
    }
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .border(1.dp, if (photo == null) AgroColors.Fuel else AgroColors.Ok, RoundedCornerShape(10.dp))
            .background(if (photo == null) AgroColors.FuelSoft else AgroColors.OkSoft)
            .clickable {
                val f = repo.newPhotoFile()
                pendingPath = f.path
                val uri: Uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
                launcher.launch(uri)
            }
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(56.dp).clip(RoundedCornerShape(8.dp)).background(Color.White), contentAlignment = Alignment.Center) {
            when {
                busy -> CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                thumb != null -> Image(thumb, null, contentScale = ContentScale.Crop, modifier = Modifier.size(56.dp))
                else -> Icon(Icons.Filled.PhotoCamera, null, tint = AgroColors.Fuel)
            }
        }
        Column {
            Text(label, style = MaterialTheme.typography.titleMedium)
            Text(
                if (photo == null) "Нажмите, чтобы сфотографировать" else "Готово. Нажмите, чтобы переснять",
                color = AgroColors.Ink2,
            )
        }
    }
}

/** Карточка проверки местоположения перед стартом смены */
@Composable
fun ZoneCard(verdict: GeoFence.Verdict?, locating: Boolean, onRetry: () -> Unit) {
    val (tone, title, text) = when {
        locating -> Triple(Color.White, "Определяем местоположение…", "Подождите, телефон ищет спутники. На улице это быстрее.")
        verdict == null -> Triple(AgroColors.AlertSoft, "Нет координат", "Не удалось получить местоположение. Включите геолокацию и попробуйте ещё раз.")
        verdict is GeoFence.Verdict.Inside -> Triple(AgroColors.OkSoft, "Вы на базе «${verdict.zone.name}»", "${verdict.distanceM.toInt()} м от центра. Можно начинать смену.")
        verdict is GeoFence.Verdict.Outside -> Triple(
            AgroColors.AlertSoft, "Вы не на базе",
            "До базы «${verdict.nearest?.name ?: "—"}» ещё ${distanceText(verdict.distanceM)}. Смену можно начать только на территории базы.",
        )
        verdict is GeoFence.Verdict.LowAccuracy -> Triple(
            AgroColors.FuelSoft, "Слабый сигнал GPS",
            "Точность ±${verdict.accuracyM.toInt()} м, нужно не хуже ±${verdict.maxM} м. Выйдите из помещения и обновите.",
        )
        verdict is GeoFence.Verdict.Mock -> Triple(AgroColors.AlertSoft, "Включена подмена геолокации", "Отключите приложение «фиктивного GPS» в настройках разработчика.")
        else -> Triple(AgroColors.FuelSoft, "Нет списка баз", "Подключитесь к интернету один раз, чтобы загрузить базы хозяйства.")
    }
    Card(tone = tone) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(text, color = AgroColors.Ink2)
            if (!locating && verdict !is GeoFence.Verdict.Inside) {
                Text(
                    "Обновить местоположение",
                    color = AgroColors.Cab,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.clickable(onClick = onRetry).padding(top = 6.dp),
                )
            }
        }
    }
}

fun distanceText(m: Double): String = if (m >= 1000) String.format(Locale("ru"), "%.1f км", m / 1000) else "${m.toInt()} м"

@Composable
fun Gap(h: Int) = androidx.compose.foundation.layout.Spacer(Modifier.height(h.dp).width(1.dp))
