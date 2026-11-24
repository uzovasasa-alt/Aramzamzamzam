/**
 * Карта на Яндекс.Картах (Yandex Maps JS API).
 * Показывает базы (круги-геозоны), трек смены и точки.
 * В режиме выбора (onPick) клик по карте возвращает координаты — так задаётся центр базы.
 *
 * Скрипт api-maps.yandex.ru загружается из index.html.
 * Компонент ждёт появления глобального `ymaps` и только потом инициализирует карту.
 */
import { useEffect, useRef, useState } from "react";

export interface MapCircle {
  lat: number;
  lon: number;
  radiusM: number;
  label?: string;
  active?: boolean;
}
export interface MapPoint {
  lat: number;
  lon: number;
  label: string;
  tone: "start" | "end" | "vehicle" | "alert" | "base";
}

/** Минимальный тип API Яндекс.Карт (скрипт подключается в index.html). */
interface YMapsApi {
  ready: (cb: () => void) => void;
  Map: new (el: HTMLElement, opts: object) => any;
  Circle: new (...args: any[]) => any;
  Polyline: new (...args: any[]) => any;
  Placemark: new (...args: any[]) => any;
  GeoObjectCollection: new () => any;
}

function getYmaps(): YMapsApi | undefined {
  return (window as unknown as { ymaps?: YMapsApi }).ymaps;
}

/** Ждём, пока скрипт Яндекс.Карт появится в window (макс. ~12 с). */
function waitForYmaps(timeoutMs = 12000): Promise<YMapsApi> {
  return new Promise((resolve, reject) => {
    const tryGet = (): boolean => {
      const api = getYmaps();
      if (!api) return false;
      api.ready(() => resolve(api));
      return true;
    };

    if (tryGet()) return;

    const started = Date.now();
    const timer = setInterval(() => {
      if (tryGet()) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            "Не удалось загрузить Яндекс.Карты. Проверьте интернет, блокировщик рекламы и API-ключ в index.html.",
          ),
        );
      }
    }, 80);
  });
}

export function MapView({
  circles = [],
  track = [],
  points = [],
  onPick,
  height = 320,
  center,
}: {
  circles?: MapCircle[];
  track?: [number, number][];
  points?: MapPoint[];
  onPick?: (lat: number, lon: number) => void;
  height?: number;
  center?: [number, number];
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [errorText, setErrorText] = useState<string | null>(null);

  // 1. Инициализация карты (ждём скрипт Яндекса)
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!el.current || mapInstance.current) return;

      try {
        const api = await waitForYmaps();
        if (cancelled || !el.current || mapInstance.current) return;

        const defaultCenter = center ?? [54.18, 45.17]; // Саранск
        const map = new api.Map(el.current, {
          center: defaultCenter,
          zoom: 12,
          controls: ["zoomControl", "fullscreenControl"],
        });

        map.events.add("click", (e: any) => {
          const coords = e.get("coords");
          pickRef.current?.(coords[0], coords[1]);
        });

        mapInstance.current = map;
        if (!cancelled) setStatus("ready");
      } catch (err: any) {
        if (!cancelled) {
          setStatus("error");
          setErrorText(err?.message ?? "Ошибка загрузки карты");
        }
      }
    };

    run();

    return () => {
      cancelled = true;
      if (mapInstance.current) {
        try {
          mapInstance.current.destroy();
        } catch {
          /* ignore */
        }
        mapInstance.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Обновление геометрии: круги баз, трек, точки
  useEffect(() => {
    const map = mapInstance.current;
    if (!map || status !== "ready") return;

    const api = getYmaps();
    if (!api) return;

    api.ready(() => {
      if (!mapInstance.current) return;

      map.geoObjects.removeAll();

      const collection = new api.GeoObjectCollection();
      const css = getComputedStyle(document.documentElement);
      const c = (v: string) => css.getPropertyValue(v).trim() || "#555";

      const zoneColor = c("--zone");
      const ink3Color = c("--ink-3");
      const trackColor = c("--track");
      const colorOk = c("--ok");
      const colorInk = c("--ink");
      const colorFuel = c("--fuel");
      const colorAlert = c("--alert");

      // Базы — круги-геозоны
      for (const z of circles) {
        const circleColor = z.active === false ? ink3Color : zoneColor;
        const circle = new api.Circle(
          [[z.lat, z.lon], z.radiusM],
          { balloonContent: z.label ?? "" },
          {
            strokeColor: circleColor,
            fillColor: circleColor,
            fillOpacity: 0.12,
            strokeWidth: 2,
            strokeStyle: z.active === false ? "dash" : "solid",
          },
        );
        collection.add(circle);
      }

      // Трек смены
      if (track.length > 1) {
        const polyline = new api.Polyline(
          track,
          {},
          {
            strokeColor: trackColor,
            strokeWidth: 3,
            strokeOpacity: 0.85,
          },
        );
        collection.add(polyline);
      }

      // Маркеры (старт/конец/техника/алерт/база)
      for (const p of points) {
        const colorMap: Record<string, string> = {
          start: colorOk,
          end: colorInk,
          vehicle: colorFuel,
          alert: colorAlert,
          base: zoneColor,
        };
        const pointColor = colorMap[p.tone] || colorInk;
        const preset =
          p.tone === "base"
            ? "islands#blueHomeCircleIcon"
            : "islands#circleIcon";

        const placemark = new api.Placemark(
          [p.lat, p.lon],
          {
            balloonContent: p.label,
            hintContent: p.label,
          },
          {
            preset,
            iconColor: pointColor,
          },
        );
        collection.add(placemark);
      }

      map.geoObjects.add(collection);

      if (collection.getLength() > 0) {
        const bounds = collection.getBounds();
        if (bounds) {
          map
            .setBounds(bounds, { checkZoomRange: true, zoomMargin: 30 })
            .then(() => {
              if (map.getZoom() > 16) map.setZoom(16);
            })
            .catch(() => {
              /* ignore */
            });
        }
      }
    });
  }, [
    status,
    JSON.stringify(circles),
    JSON.stringify(track),
    JSON.stringify(points),
  ]);

  return (
    <div style={{ position: "relative", height, width: "100%" }}>
      <div ref={el} className="map" style={{ height: "100%", width: "100%" }} />

      {status === "loading" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--panel, #f5f5f5)",
            color: "var(--ink-3, #666)",
            fontSize: 14,
            borderRadius: 8,
            zIndex: 1,
          }}
        >
          Загрузка карты…
        </div>
      )}

      {status === "error" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            padding: 16,
            background: "var(--panel, #f5f5f5)",
            color: "var(--alert, #c00)",
            fontSize: 14,
            textAlign: "center",
            borderRadius: 8,
            zIndex: 1,
          }}
        >
          <div>{errorText}</div>
          <div
            style={{ color: "var(--ink-3, #666)", fontSize: 12, maxWidth: 360 }}
          >
            Откройте консоль (F12). Часто причина — API-ключ не разрешён для
            текущего домена. В кабинете Яндекса в «Ограничение по HTTP Referer»
            укажите по одной строке: localhost и 127.0.0.1 (без http:// и без
            порта).
          </div>
        </div>
      )}
    </div>
  );
}
