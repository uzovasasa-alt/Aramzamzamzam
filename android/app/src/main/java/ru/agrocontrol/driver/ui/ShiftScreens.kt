package ru.agrocontrol.driver.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.agrocontrol.driver.AgroApp
import ru.agrocontrol.driver.data.Repository
import ru.agrocontrol.driver.data.ShiftEntity
import ru.agrocontrol.driver.data.VehicleEntity
import ru.agrocontrol.driver.domain.GeoFence
import ru.agrocontrol.driver.location.Fix
import ru.agrocontrol.driver.location.LocationHelper
import ru.agrocontrol.driver.location.TrackingService
import java.util.UUID

/** Общая «рамка» экрана формы: заголовок с кнопкой «Назад» и прокручиваемое содержимое. */
@Composable
private fun FormScaffold(title: String, onBack: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().background(AgroColors.Bg)) {
        Row(
            Modifier.fillMaxWidth().background(AgroColors.Cab).statusBarsPadding().padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onBack) { Text("‹ Назад", color = Color.White) }
            Text(title, color = Color.White, style = MaterialTheme.typography.titleMedium)
        }
        Column(
            Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
            content = content,
        )
    }
}

/* ======================= Начало смены ======================= */

@Composable
fun StartShiftScreen(onDone: () -> Unit) {
    val ctx = LocalContext.current
    val repo = AgroApp.get(ctx).repo
    val scope = rememberCoroutineScope()
    val vehicles by remember { repo.db.refs().vehiclesFlow() }.collectAsState(initial = emptyList())

    // id смены создаётся сразу — он же ключ идемпотентной синхронизации
    val shiftId = rememberSaveable { UUID.randomUUID().toString() }
    var fix by remember { mutableStateOf<Fix?>(null) }
    var verdict by remember { mutableStateOf<GeoFence.Verdict?>(null) }
    var locating by remember { mutableStateOf(true) }
    var vehicleId by rememberSaveable { mutableStateOf<String?>(null) }
    var hours by rememberSaveable { mutableStateOf("") }
    var fuel by rememberSaveable { mutableStateOf("") }
    var hoursPhoto by remember { mutableStateOf<Repository.PendingPhoto?>(null) }
    var fuelPhoto by remember { mutableStateOf<Repository.PendingPhoto?>(null) }
    var last by remember { mutableStateOf<Pair<Double?, Double?>>(null to null) }
    var saving by remember { mutableStateOf(false) }

    suspend fun locate() {
        locating = true
        val f = runCatching { LocationHelper.current(ctx) }.getOrNull()
        fix = f
        verdict = f?.let { repo.checkZone(it) }
        locating = false
    }
    LaunchedEffect(Unit) { locate() }
    LaunchedEffect(vehicleId) { vehicleId?.let { last = repo.lastKnown(it) } }

    val vehicle = vehicles.firstOrNull { it.id == vehicleId }
    val h = parseNumber(hours)
    val f = parseNumber(fuel)
    val hoursWarn = if (h != null && last.first != null && h < last.first!! - 0.05)
        "Меньше, чем в конце прошлой смены (${fmtNum(last.first)}). Проверьте — диспетчер увидит расхождение." else null
    val fuelErr = if (f != null && vehicle != null && f > vehicle.tankCapacityL * 1.05) "Больше объёма бака (${fmtNum(vehicle.tankCapacityL, 0)} л)" else null
    val inZone = verdict as? GeoFence.Verdict.Inside
    val ready = inZone != null && vehicle != null && h != null && f != null && fuelErr == null && hoursPhoto != null && fuelPhoto != null

    FormScaffold("Начало смены", onDone) {
        ZoneCard(verdict, locating) { scope.launch { locate() } }

        Text("Техника", style = MaterialTheme.typography.titleMedium)
        if (vehicles.isEmpty()) Text("Список техники пуст. Подключитесь к интернету, чтобы его загрузить.", color = AgroColors.Ink2)
        vehicles.forEach { v -> VehicleOption(v, selected = v.id == vehicleId) { vehicleId = v.id } }

        if (vehicle != null) {
            Text("Показания на старте", style = MaterialTheme.typography.titleMedium)
            NumberField(
                "Моточасы", hours, { hours = it },
                hint = last.first?.let { "В конце прошлой смены было ${fmtNum(it)}" }, error = hoursWarn,
            )
            PhotoCapture("Фото счётчика моточасов", "START_HOURS", hoursPhoto) { hoursPhoto = it }
            NumberField(
                "Топливо в баке, л", fuel, { fuel = it },
                hint = last.second?.let { "В конце прошлой смены было ${fmtNum(it)} л" }, error = fuelErr,
            )
            PhotoCapture("Фото указателя / щупа топлива", "START_FUEL", fuelPhoto) { fuelPhoto = it }
        }

        BigButton(if (saving) "Сохраняем…" else "Начать смену", enabled = ready && !saving) {
            saving = true
            scope.launch {
                repo.startShift(shiftId, vehicle!!, fix!!, inZone!!, h!!, f!!, listOfNotNull(hoursPhoto, fuelPhoto))
                TrackingService.start(ctx)
                Toast.makeText(ctx, "Смена начата. Данные уйдут на сервер, когда будет связь.", Toast.LENGTH_LONG).show()
                onDone()
            }
        }
        if (!ready && !locating) {
            Text(
                when {
                    inZone == null -> "Начать смену можно только на базе."
                    vehicle == null -> "Выберите технику."
                    h == null || f == null -> "Введите показания."
                    hoursPhoto == null || fuelPhoto == null -> "Сфотографируйте оба показания."
                    else -> ""
                },
                color = AgroColors.Ink2,
            )
        }
    }
}

@Composable
private fun VehicleOption(v: VehicleEntity, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) AgroColors.FuelSoft else Color.White)
            .border(if (selected) 2.dp else 1.dp, if (selected) AgroColors.Fuel else AgroColors.Line, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(v.name, style = MaterialTheme.typography.titleMedium)
            Text(listOfNotNull(v.regNumber, "бак ${fmtNum(v.tankCapacityL, 0)} л").joinToString(" · "), color = AgroColors.Ink2)
        }
        if (selected) Text("✓", color = AgroColors.Fuel, style = MaterialTheme.typography.titleLarge)
    }
}

/* ======================= Закрытие смены ======================= */

@Composable
fun CloseShiftScreen(onDone: () -> Unit) {
    val ctx = LocalContext.current
    val repo = AgroApp.get(ctx).repo
    val scope = rememberCoroutineScope()
    var shift by remember { mutableStateOf<ShiftEntity?>(null) }
    var vehicle by remember { mutableStateOf<VehicleEntity?>(null) }
    var refueled by remember { mutableStateOf(0.0) }
    var fix by remember { mutableStateOf<Fix?>(null) }
    var verdict by remember { mutableStateOf<GeoFence.Verdict?>(null) }
    var locating by remember { mutableStateOf(true) }
    var hours by rememberSaveable { mutableStateOf("") }
    var fuel by rememberSaveable { mutableStateOf("") }
    var note by rememberSaveable { mutableStateOf("") }
    var hoursPhoto by remember { mutableStateOf<Repository.PendingPhoto?>(null) }
    var fuelPhoto by remember { mutableStateOf<Repository.PendingPhoto?>(null) }
    var saving by remember { mutableStateOf(false) }

    suspend fun locate() {
        locating = true
        fix = runCatching { LocationHelper.current(ctx) }.getOrNull()
        verdict = fix?.let { repo.checkZone(it) }
        locating = false
    }
    LaunchedEffect(Unit) {
        val s = repo.db.shifts().openShift()
        shift = s
        if (s != null) {
            vehicle = repo.db.refs().vehicle(s.vehicleId)
            refueled = repo.db.refuels().forShift(s.id).sumOf { it.liters }
        }
        locate()
    }

    val s = shift ?: run {
        FormScaffold("Закрытие смены", onDone) { Text("Открытой смены нет.") }
        return
    }
    val h = parseNumber(hours)
    val f = parseNumber(fuel)
    val elapsedH = (repo.now() - s.startedAt) / 3_600_000.0
    val hoursErr = when {
        h == null -> null
        h < s.startEngineHours -> "Меньше, чем на старте (${fmtNum(s.startEngineHours)})"
        h - s.startEngineHours > elapsedH + 0.2 -> "Наработка ${fmtNum(h - s.startEngineHours)} ч больше длительности смены (${fmtNum(elapsedH)} ч)"
        else -> null
    }
    val consumed = if (f != null) s.startFuelL + refueled - f else null
    val needZone = repo.session.requireEndInZone
    val zoneOk = !needZone || verdict is GeoFence.Verdict.Inside
    val ready = h != null && f != null && h >= s.startEngineHours && hoursPhoto != null && fuelPhoto != null && zoneOk

    FormScaffold("Закрытие смены", onDone) {
        Card {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(s.vehicleName, style = MaterialTheme.typography.titleMedium)
                Text("Начата в ${fmtTime(s.startedAt)}, прошло ${fmtNum(elapsedH)} ч", color = AgroColors.Ink2)
                Text("На старте: ${fmtNum(s.startEngineHours)} моточ., ${fmtNum(s.startFuelL)} л" + if (refueled > 0) ", заправлено ${fmtNum(refueled)} л" else "", color = AgroColors.Ink2)
            }
        }
        if (needZone) ZoneCard(verdict, locating) { scope.launch { locate() } }

        Text("Показания в конце", style = MaterialTheme.typography.titleMedium)
        NumberField("Моточасы", hours, { hours = it }, error = hoursErr)
        PhotoCapture("Фото счётчика моточасов", "END_HOURS", hoursPhoto) { hoursPhoto = it }
        NumberField(
            "Топливо в баке, л", fuel, { fuel = it },
            hint = consumed?.let { c ->
                val norm = vehicle?.fuelNormLph
                val worked = h?.let { it - s.startEngineHours }
                "Расход за смену ${fmtNum(c)} л" + if (norm != null && worked != null && worked > 0) ", норма ${fmtNum(norm * worked)} л" else ""
            },
        )
        PhotoCapture("Фото указателя / щупа топлива", "END_FUEL", fuelPhoto) { fuelPhoto = it }
        OutlinedTextField(note, { note = it }, label = { Text("Комментарий (простой, поломка, работа на другом поле…)") }, modifier = Modifier.fillMaxWidth(), minLines = 2)

        BigButton(if (saving) "Сохраняем…" else "Закрыть смену", enabled = ready && !saving) {
            saving = true
            scope.launch {
                repo.closeShift(s, fix, h!!, f!!, note, listOfNotNull(hoursPhoto, fuelPhoto))
                TrackingService.stop(ctx)
                Toast.makeText(ctx, "Смена закрыта и отправлена на проверку.", Toast.LENGTH_LONG).show()
                onDone()
            }
        }
        if (hoursErr != null && ready) Text("Смену можно закрыть, но диспетчер увидит предупреждение.", color = AgroColors.Ink2)
    }
}

/* ======================= Заправка ======================= */

@Composable
fun RefuelScreen(onDone: () -> Unit) {
    val ctx = LocalContext.current
    val repo = AgroApp.get(ctx).repo
    val scope = rememberCoroutineScope()
    var shift by remember { mutableStateOf<ShiftEntity?>(null) }
    var liters by rememberSaveable { mutableStateOf("") }
    var note by rememberSaveable { mutableStateOf("") }
    var photo by remember { mutableStateOf<Repository.PendingPhoto?>(null) }
    var saving by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { shift = repo.db.shifts().openShift() }

    val l = parseNumber(liters)
    FormScaffold("Заправка", onDone) {
        Text("Заправку вносите сразу — иначе в конце смены расход не сойдётся.", color = AgroColors.Ink2)
        NumberField("Сколько залили, л", liters, { liters = it })
        PhotoCapture("Фото счётчика колонки или накладной", "REFUEL_METER", photo) { photo = it }
        OutlinedTextField(note, { note = it }, label = { Text("Откуда топливо (заправщик, АЗС…)") }, modifier = Modifier.fillMaxWidth())
        BigButton(if (saving) "Сохраняем…" else "Сохранить заправку", enabled = shift != null && l != null && l > 0 && !saving) {
            saving = true
            scope.launch {
                val fix = runCatching { LocationHelper.current(ctx) }.getOrNull()
                repo.addRefuel(shift!!, l!!, note, fix, photo)
                Toast.makeText(ctx, "Заправка сохранена", Toast.LENGTH_SHORT).show()
                onDone()
            }
        }
    }
}
