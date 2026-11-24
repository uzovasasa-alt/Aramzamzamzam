# Контракт синхронизации мобильного приложения

Полная документация со всеми эндпоинтами — Swagger на `/api/docs`. Здесь описано главное: как телефон отправляет офлайн-данные.

## Авторизация

`POST /api/auth/login` `{login, password}` → `{accessToken, refreshToken, user}`.
Access-токен живёт 1 час, refresh-токен — 60 дней. При ответе 401 вызывается `POST /api/auth/refresh` `{refreshToken}`.
Если у пользователя сменили пароль или его заблокировали, все refresh-токены перестают работать (`token_version`).

## Справочники

`GET /api/mobile/bootstrap` → техника (с последними известными моточасами и топливом), базы (центр и радиус), настройки (`maxGpsAccuracyM`, `requireEndInZone`), `serverTime` и открытая смена.

## Отправка данных

`POST /api/mobile/sync`

```json
{
  "deviceId": "…",
  "shifts":      [{ "id": "uuid с телефона", "vehicleId": "…", "startedAt": "ISO", "endedAt": null,
                    "startLat": 54.1, "startLon": 44.9, "startAccuracyM": 12, "mockLocation": false,
                    "startEngineHours": 4120.5, "startFuelL": 140, "clientUpdatedAt": "ISO" }],
  "refuelings":  [{ "id": "…", "vehicleId": "…", "shiftId": "…", "liters": 100, "occurredAt": "ISO", "clientUpdatedAt": "ISO" }],
  "photos":      [{ "id": "…", "kind": "START_HOURS", "shiftId": "…", "takenAt": "ISO", "sha256": "…" }],
  "trackPoints": [{ "shiftId": "…", "ts": "ISO", "lat": 54.1, "lon": 44.9, "accuracyM": 10, "speedKmh": 12 }]
}
```

Ответ:

```json
{
  "serverTime": "ISO",
  "shifts":     [{ "id": "…", "result": "ok" }],
  "refuelings": [{ "id": "…", "result": "rejected", "reason": "RETRY: смена ещё не синхронизирована" }],
  "photos":     [{ "id": "…", "result": "ok" }],
  "trackShiftsAccepted": ["…"],
  "shiftStates": [{ "id": "…", "status": "APPROVED", "reviewComment": null, "anomalyCount": 0 }]
}
```

Правила:
* **Идемпотентность.** id генерирует телефон. Повторная отправка того же объекта не создаёт дубль. Обновление применяется, только если `clientUpdatedAt` новее сохранённого.
* `result: "ok"` означает, что объект больше не нужно отправлять. `rejected` с причиной `RETRY:…` — повторить позже. Другой `rejected` — ошибка данных, её нужно показать водителю.
* Смену, проверенную модератором (`APPROVED` / `REJECTED`), изменить нельзя.
* Точки трека телефон удаляет только для смен из `trackShiftsAccepted`.
* Временный сбой (5xx, нет сети) — повторить весь пакет позже. Это безопасно.

## Загрузка фото

`PUT /api/mobile/photos/{id}`, `multipart/form-data`, поле `file` (JPEG/PNG/WebP, до 8 МБ).
Метаданные фото должны прийти раньше через `/sync`, иначе сервер ответит 404 `RETRY`. Если SHA-256 файла не совпадает с заявленным, ответ будет 400.

## Телеметрия своих устройств

`POST /api/telemetry/ingest`, заголовок `X-Telemetry-Key`:

```json
{ "imei": "…", "records": [{ "ts": "ISO", "lat": 54.1, "lon": 44.9, "speedKmh": 0,
                             "params": { "fuel_l": 312.5, "engine_hours": 1532.4, "ignition": 1 } }] }
```

Какой параметр что означает, задаётся у техники в поле «Расшифровка параметров» (`sensorMapping`).
