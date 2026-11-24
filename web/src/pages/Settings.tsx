import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorLine, Field, toast } from '../components/ui';
import { useApi } from '../lib';

interface Settings {
  maxGpsAccuracyM: number; defaultNormTolerancePct: number; engineHoursGapTolerance: number; fuelGapToleranceL: number;
  maxShiftHours: number; requireEndInZone: boolean; drainMinLiters: number; drainWindowMin: number; sensorManualMismatchL: number;
  telegramChatId?: string | null;
}

const NUM_FIELDS: { k: keyof Settings; label: string; hint: string }[] = [
  { k: 'maxGpsAccuracyM', label: 'Точность GPS для старта, м', hint: 'Хуже — приложение попросит подождать сигнала' },
  { k: 'defaultNormTolerancePct', label: 'Допуск перерасхода, %', hint: 'Если у техники не задан свой' },
  { k: 'fuelGapToleranceL', label: 'Расхождение топлива между сменами, л', hint: 'Погрешность замера щупом или по стрелке' },
  { k: 'engineHoursGapTolerance', label: 'Расхождение моточасов между сменами, ч', hint: 'Больше — «техника работала без смены»' },
  { k: 'maxShiftHours', label: 'Максимальная длина смены, ч', hint: 'Длиннее — вероятно, забыли закрыть' },
  { k: 'drainMinLiters', label: 'Слив по датчику: падение от, л', hint: 'На стоянке, за окно ниже' },
  { k: 'drainWindowMin', label: 'Слив по датчику: окно, мин', hint: '' },
  { k: 'sensorManualMismatchL', label: 'Водитель против датчика: разница от, л', hint: '' },
];

export function SettingsPage() {
  const org = useApi<{ name: string; settings: Settings }>('/organizations/current');
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (org.data) setS(org.data.settings); }, [org.data]);

  const save = async () => {
    if (!s) return;
    setErr(null);
    try {
      const body: Record<string, unknown> = { requireEndInZone: s.requireEndInZone, telegramChatId: s.telegramChatId || undefined };
      for (const f of NUM_FIELDS) body[f.k] = Number(String(s[f.k]).replace(',', '.'));
      setS(await api<Settings>('/organizations/current/settings', { method: 'PATCH', body }));
      toast({ text: 'Настройки сохранены. Новые пороги применяются к следующим проверкам.', tone: 'info' });
    } catch (e: any) {
      setErr(e.message);
    }
  };

  if (!s) return <div className="page muted">Загрузка…</div>;
  return (
    <div className="page page-narrow">
      <header className="page-head"><h1>Настройки хозяйства</h1></header>
      <section className="panel">
        <h2>Пороги проверки</h2>
        <div className="form-grid">
          {NUM_FIELDS.map((f) => (
            <Field key={f.k} label={f.label} hint={f.hint || undefined}>
              <input inputMode="decimal" value={String(s[f.k] ?? '')} onChange={(e) => setS({ ...s, [f.k]: e.target.value as any })} />
            </Field>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={s.requireEndInZone} onChange={(e) => setS({ ...s, requireEndInZone: e.target.checked })} /> Смену нужно закрывать на базе</label>
      </section>
      <section className="panel">
        <h2>Уведомления в Telegram</h2>
        <p className="muted small">
          Нарушения средней и высокой важности будут приходить в чат. Добавьте бота хозяйства в группу диспетчеров,
          узнайте id чата (например, через @getmyid_bot) и впишите его сюда. Токен бота задаётся на сервере (TELEGRAM_BOT_TOKEN).
        </p>
        <Field label="ID чата"><input value={s.telegramChatId ?? ''} onChange={(e) => setS({ ...s, telegramChatId: e.target.value })} placeholder="-1001234567890" /></Field>
      </section>
      <ErrorLine error={err} />
      <button className="btn btn-primary" onClick={save}>Сохранить настройки</button>
    </div>
  );
}
