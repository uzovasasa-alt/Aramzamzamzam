package ru.agrocontrol.driver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.agrocontrol.driver.domain.GeoFence

class GeoFenceTest {
    private val base = GeoFence.Zone("b1", "Машинный двор", 54.1838, 45.1749, 300)

    @Test fun insideBase() {
        val v = GeoFence.check(54.1840, 45.1750, 15f, false, listOf(base), 100)
        assertTrue(v is GeoFence.Verdict.Inside)
    }

    @Test fun outsideBase() {
        val v = GeoFence.check(54.1900, 45.1749, 15f, false, listOf(base), 100)
        assertTrue(v is GeoFence.Verdict.Outside)
        assertEquals(390.0, v.distanceM, 30.0) // ~690 м до центра минус 300 м радиуса
    }

    @Test fun lowAccuracyIsRejected() {
        assertTrue(GeoFence.check(54.1840, 45.1750, 500f, false, listOf(base), 100) is GeoFence.Verdict.LowAccuracy)
    }

    @Test fun mockIsRejected() {
        assertTrue(GeoFence.check(54.1840, 45.1750, 5f, true, listOf(base), 100) is GeoFence.Verdict.Mock)
    }

    @Test fun oneDegreeLatitude() {
        assertEquals(111_195.0, GeoFence.distanceM(54.0, 45.0, 55.0, 45.0), 200.0)
    }
}
