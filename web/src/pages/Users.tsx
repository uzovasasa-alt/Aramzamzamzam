import { useState } from 'react';
import { api, Role, User } from '../api';
import { ErrorLine, Field, Modal, toast } from '../components/ui';
import { ROLE, useApi } from '../lib';

export function UsersPage() {
  const list = useApi<User[]>('/users');
  const [edit, setEdit] = useState<(Partial<User> & { password?: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!edit) return;
    setErr(null);
    try {
      if (edit.id) {
        await api(`/users/${edit.id}`, {
          method: 'PATCH',
          body: { role: edit.role, fullName: edit.fullName, phone: edit.phone || undefined, isActive: edit.isActive, password: edit.password || undefined },
        });
      } else {
        await api('/users', { method: 'POST', body: { role: edit.role, fullName: edit.fullName, login: edit.login, password: edit.password, phone: edit.phone || undefined } });
      }
      toast({ text: 'Сохранено', tone: 'info' });
      setEdit(null);
      list.reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Сотрудники</h1>
        <button className="btn btn-primary" onClick={() => setEdit({ role: 'DRIVER', isActive: true })}>Добавить сотрудника</button>
      </header>
      <ErrorLine error={list.error} />
      <div className="panel panel-flush">
        <table className="table">
          <thead><tr><th>ФИО</th><th>Роль</th><th>Логин</th><th>Телефон</th><th /></tr></thead>
          <tbody>
            {list.data?.map((u) => (
              <tr key={u.id} className={u.isActive ? '' : 'inactive'}>
                <td>{u.fullName}{!u.isActive && <span className="flag">заблокирован</span>}</td>
                <td>{ROLE[u.role]}</td>
                <td className="num">{u.login}</td>
                <td className="num">{u.phone ?? '—'}</td>
                <td className="r"><button className="btn btn-sm" onClick={() => setEdit(u)}>Изменить</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={edit.id ? edit.fullName ?? '' : 'Новый сотрудник'} onClose={() => setEdit(null)}>
          <Field label="ФИО"><input value={edit.fullName ?? ''} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} /></Field>
          <div className="form-grid">
            <Field label="Роль">
              <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value as Role })}>
                <option value="DRIVER">Водитель — мобильное приложение</option>
                <option value="MODERATOR">Модератор — проверяет смены</option>
                <option value="ADMIN">Администратор — всё, включая настройки</option>
              </select>
            </Field>
            <Field label="Телефон"><input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} inputMode="tel" /></Field>
            {!edit.id && <Field label="Логин"><input value={edit.login ?? ''} onChange={(e) => setEdit({ ...edit, login: e.target.value.trim() })} /></Field>}
            <Field label={edit.id ? 'Новый пароль' : 'Пароль'} hint={edit.id ? 'Оставьте пустым, чтобы не менять. Смена пароля выходит из всех устройств.' : 'Не короче 4 символов'}>
              <input type="text" value={edit.password ?? ''} onChange={(e) => setEdit({ ...edit, password: e.target.value })} autoComplete="new-password" />
            </Field>
          </div>
          {edit.id && <label className="check"><input type="checkbox" checked={!edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: !e.target.checked })} /> Заблокировать доступ</label>}
          <ErrorLine error={err} />
          <div className="modal-actions">
            <button className="btn" onClick={() => setEdit(null)}>Отмена</button>
            <button className="btn btn-primary" onClick={save}>Сохранить</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
