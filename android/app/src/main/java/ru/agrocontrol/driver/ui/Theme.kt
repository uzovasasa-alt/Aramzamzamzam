package ru.agrocontrol.driver.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** Те же цвета, что в веб-панели: тёмная «кабина», янтарная стрелка топлива, красный — нарушения. */
object AgroColors {
    val Cab = Color(0xFF1F2B2D)
    val Fuel = Color(0xFFD98E04)
    val FuelSoft = Color(0xFFFBEFD6)
    val Ok = Color(0xFF3C7A4A)
    val OkSoft = Color(0xFFE3F0E5)
    val Alert = Color(0xFFC2412D)
    val AlertSoft = Color(0xFFF8E3DF)
    val Bg = Color(0xFFEEF1EF)
    val Ink = Color(0xFF1C2526)
    val Ink2 = Color(0xFF4A5759)
    val Ink3 = Color(0xFF8A9597)
    val Line = Color(0xFFD8DEDC)
}

@Composable
fun AgroTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = AgroColors.Cab,
            onPrimary = Color.White,
            secondary = AgroColors.Fuel,
            background = AgroColors.Bg,
            surface = Color.White,
            onSurface = AgroColors.Ink,
            onSurfaceVariant = AgroColors.Ink2,
            error = AgroColors.Alert,
            outline = AgroColors.Line,
        ),
        // Крупный шрифт: телефон в кабине, на ходу, в перчатках
        typography = Typography(
            headlineSmall = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Bold),
            titleLarge = TextStyle(fontSize = 21.sp, fontWeight = FontWeight.SemiBold),
            titleMedium = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
            bodyLarge = TextStyle(fontSize = 17.sp),
            bodyMedium = TextStyle(fontSize = 15.sp),
            labelLarge = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
        ),
        content = content,
    )
}
