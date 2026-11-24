import { useState } from "react";
import { api, auth, Base } from "../api";
import { MapView } from "../components/MapView";
import { Empty, ErrorLine, Field, toast } from "../components/ui";
import { useApi } from "../lib";

/**
 * Базы — геозоны, на территории которых водитель может начать смену.
 * Центр задаётся кликом по карте, радиус — ползунком.
 */
export function BasesPage() {
  const list = useApi<Base[]>("/bases");
  const isAdmin =
    auth.user?.role === "ADMIN" || auth.user?.role === "SUPERADMIN";
  const [edit, setEdit] = useState<Partial<Base> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!edit) return;
    setErr(null);
    const body = {
      name: edit.name,
      lat: edit.lat,
      lon: edit.lon,
      radiusM: Math.round(edit.radiusM ?? 200),
      isActive: edit.isActive ?? true,
    };
    try {
      if (edit.id) await api(`/bases/${edit.id}`, { method: "PATCH", body });
      else await api("/bases", { method: "POST", body });
      toast({ text: "База сохранена", tone: "info" });
      setEdit(null);
      list.reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const baseList = list.data ?? [];

  // Круги геозон для всех баз
  const circles = baseList
    .filter((b) => b.id !== edit?.id)
    .map((b) => ({
      lat: b.lat,
      lon: b.lon,
      radiusM: b.radiusM,
      label: b.name,
      active: b.isActive,
    }));
  if (edit?.lat != null && edit.lon != null) {
    circles.push({
      lat: edit.lat,
      lon: edit.lon,
      radiusM: edit.radiusM ?? 200,
      label: edit.name ?? "Новая база",
      active: true,
    });
  }

  // Маркеры в центре каждой базы
  const points = baseList
    .filter((b) => b.id !== edit?.id)
    .map((b) => ({
      lat: b.lat,
      lon: b.lon,
      label: `${b.name}${b.isActive ? "" : " (не действует)"}`,
      tone: "base" as const,
    }));
  if (edit?.lat != null && edit.lon != null) {
    points.push({
      lat: edit.lat,
      lon: edit.lon,
      label: edit.name ?? "Новая база",
      tone: "base" as const,
    });
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Базы</h1>
        {isAdmin && !edit && (
          <button
            className="btn btn-primary"
            onClick={() => setEdit({ radiusM: 250 })}
          >
            Добавить базу
          </button>
        )}
      </header>
      <p className="lead">
        Водитель может начать смену, только находясь внутри круга базы. Делайте
        радиус с запасом на территорию машинного двора, но не больше — иначе в
        зону попадут поля.
      </p>
      <div className="grid-2 grid-map">
        <section className="panel">
          {edit && (
            <div className="map-hint">
              Кликните по карте, чтобы поставить центр базы
            </div>
          )}
          <MapView
            height={460}
            circles={circles}
            points={points}
            onPick={
              edit
                ? (lat, lon) => setEdit((e) => ({ ...e, lat, lon }))
                : undefined
            }
          />
        </section>
        <section className="panel">
          {edit ? (
            <>
              <h2>{edit.id ? "Изменить базу" : "Новая база"}</h2>
              <Field label="Название">
                <input
                  value={edit.name ?? ""}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  placeholder="Машинный двор"
                  autoFocus
                />
              </Field>
              <Field label={`Радиус: ${edit.radiusM ?? 200} м`}>
                <input
                  type="range"
                  min={50}
                  max={2000}
                  step={10}
                  value={edit.radiusM ?? 200}
                  onChange={(e) =>
                    setEdit({ ...edit, radiusM: Number(e.target.value) })
                  }
                />
              </Field>
              <div className="muted small">
                {edit.lat != null
                  ? `Центр: ${edit.lat.toFixed(5)}, ${edit.lon!.toFixed(5)}`
                  : "Центр не выбран"}
              </div>
              {edit.id && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={edit.isActive ?? true}
                    onChange={(e) =>
                      setEdit({ ...edit, isActive: e.target.checked })
                    }
                  />{" "}
                  Действует
                </label>
              )}
              <ErrorLine error={err} />
              <div className="modal-actions">
                <button className="btn" onClick={() => setEdit(null)}>
                  Отмена
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!edit.name || edit.lat == null}
                  onClick={save}
                >
                  Сохранить
                </button>
              </div>
            </>
          ) : (
            <>
              <ul className="list">
                {list.data?.map((b) => (
                  <li key={b.id} className={b.isActive ? "" : "inactive"}>
                    <div>
                      <b>{b.name}</b>
                      <div className="muted small">
                        радиус {b.radiusM} м{b.isActive ? "" : ", не действует"}
                      </div>
                    </div>
                    {isAdmin && (
                      <button className="btn btn-sm" onClick={() => setEdit(b)}>
                        Изменить
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {list.data?.length === 0 && (
                <Empty>
                  Баз пока нет. Без базы водители не смогут начать смену.
                </Empty>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
