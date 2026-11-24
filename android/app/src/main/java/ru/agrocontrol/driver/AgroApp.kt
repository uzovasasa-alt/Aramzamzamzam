package ru.agrocontrol.driver

import android.app.Application
import android.content.Context
import ru.agrocontrol.driver.data.AppDatabase
import ru.agrocontrol.driver.data.Repository
import ru.agrocontrol.driver.data.SessionStore
import ru.agrocontrol.driver.domain.TrustedClock
import ru.agrocontrol.driver.sync.SyncWorker

/** Простейший «контейнер зависимостей» без Hilt — для MVP понятнее. */
class AgroApp : Application() {
    val db by lazy { AppDatabase.create(this) }
    val session by lazy { SessionStore(this) }
    val repo by lazy { Repository(this, db, session, TrustedClock(session)) }

    override fun onCreate() {
        super.onCreate()
        if (session.accessToken != null) {
            SyncWorker.schedulePeriodic(this)
            SyncWorker.requestNow(this)
        }
    }

    companion object {
        fun get(ctx: Context) = ctx.applicationContext as AgroApp
    }
}
