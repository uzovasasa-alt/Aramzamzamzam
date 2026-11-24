import { FormEvent, useState } from 'react';
import { login } from '../api';

export function LoginPage() {
  const [l, setL] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(l, p);
    } catch (e: any) {
      setErr(e.status === 401 ? 'Неверный логин или пароль' : `Не удалось войти: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen login-bg">
      <form className="login-card" onSubmit={submit}>
        <div className="brand brand-login">
          <span className="brand-mark" aria-hidden />
          <div className="brand-name">АгроКонтроль</div>
        </div>
        <p className="login-lead">Диспетчерская: смены, топливо и моточасы техники хозяйства.</p>
        <label className="field">
          <span className="field-label">Логин</span>
          <input autoFocus autoComplete="username" value={l} onChange={(e) => setL(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field-label">Пароль</span>
          <input type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required />
        </label>
        {err && <div className="error-line" role="alert">{err}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
      </form>
    </div>
  );
}
