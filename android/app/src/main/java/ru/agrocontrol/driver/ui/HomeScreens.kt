package ru.agrocontrol.driver.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import retrofit2.HttpException
import ru.agrocontrol.driver.AgroApp
import ru.agrocontrol.driver.data.ShiftEntity
import ru.agrocontrol.driver.data.isPending
import ru.agrocontrol.driver.sync.SyncWorker
import java.io.IOException

/* ======================= Вход ======================= */

@Composable
fun LoginScreen() {
    val repo = AgroApp.get(LocalContext.current).repo
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(repo.session.serverUrl) }
    var login by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().background(AgroColors.Cab).statusBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Gap(30)
        Text("АгроКонтроль", style = MaterialTheme.typography.headlineSmall, color = Color.White)
        Text("Учёт смен, моточасов и топлива. Логин и пароль выдаёт диспетчер хозяйства.", color = Color(0xFFC9D3D2))
        Card {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(login, { login = it }, label = { Text("Логин") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(
                    password, { password = it }, label = { Text("Пароль") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    server, { server = it }, label = { Text("Адрес сервера") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth(),
                )
                error?.let { Text(it, color = AgroColors.Alert) }
                Button(
                    onClick = {
                        busy = true; error = null
                        scope.launch {
                            try {
                                repo.login(server, login, password)
                            } catch (e: HttpException) {
                                error = if (e.code() == 401) "Неверный логин или пароль" else "Сервер ответил ошибкой ${e.code()}"
                            } catch (e: IOException) {
                                error = "Нет связи с сервером. Для первого входа нужен интернет."
                            } catch (e: Exception) {
                                error = e.message ?: "Ошибка входа"
                            } finally {
                                busy = false
                            }
                        }
                    },
                    enabled = !busy && login.isNotBlank() && password.isNotBlank(),
                    modifier = Modifier.fillMaxWidth().height(54.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = AgroColors.Cab),
                ) { Text(if (busy) "Входим…" else "Войти") }
            }
        }
    }
}

/* ======================= Главный экран ======================= */

@Composable
fun HomeScreen(onNavigate: (Screen) -> Unit) {
    val ctx = LocalContext.current
    val repo = AgroApp.get(ctx).repo
    val scope = rememberCoroutineScope()
    val user by repo.session.user.collectAsState()
    // Flow из Room создаём один раз (remember), иначе подписка пересоздавалась бы при каждой перерисовке
    val open by remember { repo.db.shifts().openShiftFlow() }.collectAsState(initial = null)
    val history by remember { repo.db.shifts().historyFlow() }.collectAsState(initial = emptyList())
    val pending by remember { repo.db.queue().pendingCountFlow() }.collectAsState(initial = 0)
    val lastSync by repo.session.lastSyncAt.collectAsState()
    val refuelsFlow = remember(open?.id) { open?.let { repo.db.refuels().forShiftFlow(it.id) } ?: flowOf(emptyList()) }
    val refuels by refuelsFlow.collectAsState(initial = emptyList())
    var menu by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().background(AgroColors.Bg)) {
        // Шапка
        Row(
            Modifier.fillMaxWidth().background(AgroColors.Cab).statusBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(user?.fullName ?: "", color = Color.White, style = MaterialTheme.typography.titleMedium)
                Text(
                    when {
                        pending > 0 -> "Ждут отправки: $pending"
                        lastSync > 0 -> "Всё отправлено · ${fmtTime(lastSync)}"
                        else -> "Ещё не синхронизировано"
                    },
                    color = if (pending > 0) AgroColors.Fuel else Color(0xFFC9D3D2),
                )
            }
            Box {
                TextButton(onClick = { menu = true }) { Text("Меню", color = Color.White) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Отправить сейчас") }, onClick = { menu = false; SyncWorker.requestNow(ctx) })
                    DropdownMenuItem(
                        text = { Text("Выйти") },
                        enabled = open == null && pending == 0,
                        onClick = { menu = false; scope.launch { repo.logout() } },
                    )
                }
            }
        }

        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                val s = open
                if (s == null) {
                    Card {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("Смена не начата", style = MaterialTheme.typography.titleLarge)
                            Text("Начать смену можно только на территории базы. Понадобятся фото счётчика моточасов и уровня топлива.", color = AgroColors.Ink2)
                            BigButton("Начать смену") { onNavigate(Screen.START) }
                        }
                    }
                } else {
                    Card(tone = AgroColors.FuelSoft) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text("Идёт смена с ${fmtTime(s.startedAt)}", style = MaterialTheme.typography.titleLarge)
                            Text("${s.vehicleName} · ${s.baseName ?: ""}", color = AgroColors.Ink2)
                            Text("На старте: ${fmtNum(s.startEngineHours)} моточ., ${fmtNum(s.startFuelL)} л", color = AgroColors.Ink2)
                            if (refuels.isNotEmpty()) Text("Заправки: ${refuels.joinToString { fmtNum(it.liters) + " л" }}", color = AgroColors.Ink2)
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                OutlinedButton(onClick = { onNavigate(Screen.REFUEL) }, modifier = Modifier.weight(1f).height(54.dp)) { Text("Заправка") }
                                Button(
                                    onClick = { onNavigate(Screen.CLOSE) },
                                    modifier = Modifier.weight(1f).height(54.dp),
                                    colors = ButtonDefaults.buttonColors(containerColor = AgroColors.Cab),
                                ) { Text("Закрыть смену") }
                            }
                        }
                    }
                }
            }
            val closed = history.filter { it.endedAt != null }
            if (closed.isNotEmpty()) item { Text("Мои смены", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp)) }
            items(closed, key = { it.id }) { ShiftRow(it) }
        }
    }
}

@Composable
private fun ShiftRow(s: ShiftEntity) {
    val (label, color) = when {
        s.syncError != null -> "Ошибка: ${s.syncError}" to AgroColors.Alert
        s.isPending -> "Ждёт отправки" to AgroColors.Fuel
        s.serverStatus == "APPROVED" -> "Принята" to AgroColors.Ok
        s.serverStatus == "REJECTED" -> "Отклонена" to AgroColors.Alert
        else -> "На проверке" to AgroColors.Ink2
    }
    Card {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row {
                Text(fmtDateTime(s.startedAt), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Text(label, color = color)
            }
            Text(s.vehicleName, color = AgroColors.Ink2)
            val hours = (s.endEngineHours ?: s.startEngineHours) - s.startEngineHours
            Text("Наработка ${fmtNum(hours)} моточ.", color = AgroColors.Ink2)
            s.reviewComment?.let { Text("Комментарий диспетчера: $it", color = AgroColors.Ink) }
        }
    }
}

@Composable
fun BigButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().height(58.dp),
        colors = ButtonDefaults.buttonColors(containerColor = AgroColors.Cab),
    ) { Text(text) }
}
