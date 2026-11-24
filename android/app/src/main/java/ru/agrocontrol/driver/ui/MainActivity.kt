package ru.agrocontrol.driver.ui

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import ru.agrocontrol.driver.AgroApp

/** Экраны приложения. Навигация простая — без библиотек. */
enum class Screen { HOME, START, CLOSE, REFUEL }

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = AgroApp.get(this)
        setContent {
            AgroTheme {
                val user by app.session.user.collectAsState()
                if (user == null) {
                    LoginScreen()
                } else {
                    Permissions()
                    var screen by rememberSaveable { mutableStateOf(Screen.HOME) }
                    BackHandler(enabled = screen != Screen.HOME) { screen = Screen.HOME }
                    when (screen) {
                        Screen.HOME -> HomeScreen(onNavigate = { screen = it })
                        Screen.START -> StartShiftScreen(onDone = { screen = Screen.HOME })
                        Screen.CLOSE -> CloseShiftScreen(onDone = { screen = Screen.HOME })
                        Screen.REFUEL -> RefuelScreen(onDone = { screen = Screen.HOME })
                    }
                }
            }
        }
    }
}

/** Разрешения запрашиваем сразу после входа: без геолокации и камеры смену не начать. */
@Composable
private fun Permissions() {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }
    LaunchedEffect(Unit) {
        val perms = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
        launcher.launch(perms.toTypedArray())
    }
}
