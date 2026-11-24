import { useState } from 'react';
import { api, auth } from '../api';
import { ErrorLine, Field, Modal, toast } from '../components/ui';
import { fmt, go, useApi } from '../lib';

interface Org { id: string; name: string; inn: string | null; isActive: boolean; createdAt: string }

/** Только для суперадмина: подключение новых хозяйств-клиентов (SaaS) и переключение между ними. */
export function OrgsPage() {
  const list = useApi<Org[]>('/organizations');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', inn: '', adminFullName: '', adminLogin: '', adminPassword: '' });
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setErr(null);
    try {
      await api('/organizations', { method: 'POST', body: { ...f, inn: f.inn || undefined } });
      toast({ text: `Хозяйство «${f.name}» подключено`, tone: 'info' });
      setAdding(false);
      list.reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Хозяйства</h1>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>Подключить хозяйство</button>
      </header>
      <div className="panel panel-flush">
        <table className="table">
          <thead><tr><th>Название</th><th>ИНН</th><th>Подключено</th><th /></tr></thead>
          <tbody>
            {list.data?.map((o) => (
              <tr key={o.id}>
                <td>{o.name}</td>
                <td className="num">{o.inn ?? '—'}</td>
                <td>{fmt.date(o.createdAt)}</td>
                <td className="r">
                  <button className="btn btn-sm" onClick={() => { auth.setOrg(o.id); go('/'); }}>
                    {auth.orgId === o.id ? 'Открыто' : 'Открыть'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && (
        <Modal title="Новое хозяйство" onClose={() => setAdding(false)}>
          <div className="form-grid">
            <Field label="Название"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="ИНН"><input value={f.inn} onChange={(e) => setF({ ...f, inn: e.target.value })} inputMode="numeric" /></Field>
            <Field label="Администратор: ФИО"><input value={f.adminFullName} onChange={(e) => setF({ ...f, adminFullName: e.target.value })} /></Field>
            <Field label="Логин администратора"><input value={f.adminLogin} onChange={(e) => setF({ ...f, adminLogin: e.target.value.trim() })} /></Field>
            <Field label="Пароль администратора" hint="Не короче 6 символов"><input value={f.adminPassword} onChange={(e) => setF({ ...f, adminPassword: e.target.value })} /></Field>
          </div>
          <ErrorLine error={err} />
          <div className="modal-actions">
            <button className="btn" onClick={() => setAdding(false)}>Отмена</button>
            <button className="btn btn-primary" onClick={create}>Подключить</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
