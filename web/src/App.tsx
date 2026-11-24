import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, auth, logout } from './api';
import { Toasts, toast } from './components/ui';
import { go, ROLE, useApi, useRoute } from './lib';
import { AnomaliesPage } from './pages/Anomalies';
import { BasesPage } from './pages/Bases';
import { DashboardPage } from './pages/Dashboard';
import { LoginPage } from './pages/Login';
import { OrgsPage } from './pages/Orgs';
import { RefuelingsPage } from './pages/Refuelings';
import { SettingsPage } from './pages/Settings';
import { ShiftPage } from './pages/Shift';
import { ShiftsPage } from './pages/Shifts';
import { UsersPage } from './pages/Users';
import { VehiclePage } from './pages/Vehicle';
import { VehiclesPage } from './pages/Vehicles';

function useAuth() {
  // токен входит в снимок: после его обновления переподключается поток уведомлений
  return useSyncExternalStore(auth.onChange, () => `${auth.user?.id ?? ''}|${auth.orgId ?? ''}|${auth.token ?? ''}`);
}

export function App() {
  useAuth();
  const user = auth.user;
  if (!user) return <LoginPage />;
  if (user.role === 'DRIVER') {
    return (
      <div className="center-screen">
        <div className="login-card">
          <h1>Для водителей — мобильное приложение</h1>
          <p>Веб-панель предназначена для диспетчеров и администраторов. Смены водитель открывает и закрывает в приложении на телефоне.</p>
          <button className="btn" onClick={logout}>Выйти</button>
        </div>
      </div>
    );
  }
  if (user.role === 'SUPERADMIN' && !auth.orgId) return <Shell><OrgsPage /></Shell>;
  return <Shell><Routes /></Shell>;
}

function Routes() {
  const route = useRoute();
  const [, section, id] = route.split('?')[0].split('/');
  switch (section) {
    case '': return <DashboardPage />;
    case 'shifts': return id ? <ShiftPage id={id} /> : <ShiftsPage />;
    case 'anomalies': return <AnomaliesPage />;
    case 'vehicles': return id ? <VehiclePage id={id} /> : <VehiclesPage />;
    case 'refuelings': return <RefuelingsPage />;
    case 'bases': return <BasesPage />;
    case 'users': return <UsersPage />;
    case 'settings': return <SettingsPage />;
    case 'orgs': return <OrgsPage />;
    default: return <DashboardPage />;
  }
}

const NAV: { path: string; label: string; admin?: boolean; superOnly?: boolean }[] = [
  { path: '/', label: 'Сводка' },
  { path: '/shifts', label: 'Смены' },
  { path: '/anomalies', label: 'Нарушения' },
  { path: '/vehicles', label: 'Техника' },
  { path: '/refuelings', label: 'Заправки' },
  { path: '/bases', label: 'Базы' },
  { path: '/users', label: 'Сотрудники', admin: true },
  { path: '/settings', label: 'Настройки', admin: true },
  { path: '/orgs', label: 'Хозяйства', superOnly: true },
];

function Shell({ children }: { children: React.ReactNode }) {
  const user = auth.user!;
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const isAdmin = user.role === 'ADMIN' || user.role === 'SUPERADMIN';
  const hasOrg = user.role !== 'SUPERADMIN' || !!auth.orgId;
  const org = useApi<{ name: string }>(hasOrg ? '/organizations/current' : null);
  const count = useApi<{ total: number; bySeverity: Record<string, number> }>(hasOrg ? '/anomalies/count' : null);

  // Живые уведомления о новых нарушениях (Server-Sent Events)
  useEffect(() => {
    if (!hasOrg || !auth.token) return;
    const qs = `access_token=${encodeURIComponent(auth.token)}`;
    const es = new EventSource(`/api/anomalies/stream?${qs}`);
    es.addEventListener('anomaly', (e) => {
      try {
        const a = JSON.parse((e as MessageEvent).data);
        toast({ text: a.message, tone: a.severity === 'HIGH' ? 'alert' : 'info', onClick: () => go(a.shiftId ? `/shifts/${a.shiftId}` : '/anomalies') });
        count.reload();
      } catch { /* */ }
    });
    // Токен истёк — запрос к API обновит его, и эффект переподключится с новым
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) api('/auth/me').catch(() => {}); };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasOrg, auth.token]);

  useEffect(() => setMenuOpen(false), [route]);
  useEffect(() => {
    const t = setInterval(count.reload, 60_000);
    return () => clearInterval(t);
  }, [count.reload]);

  const active = (p: string) => (p === '/' ? route === '/' : route.split('?')[0].startsWith(p));
  const newCount = count.data?.total ?? 0;

  return (
    <div className="shell">
      <aside className={`side ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <div className="brand-name">АгроКонтроль</div>
            <div className="brand-org">{org.data?.name ?? (user.role === 'SUPERADMIN' ? 'Выберите хозяйство' : '')}</div>
          </div>
        </div>
        <nav>
          {NAV.filter((n) => (!n.admin || isAdmin) && (!n.superOnly || user.role === 'SUPERADMIN') && (hasOrg || n.superOnly)).map((n) => (
            <a key={n.path} href={`#${n.path}`} className={active(n.path) ? 'active' : ''}>
              {n.label}
              {n.path === '/anomalies' && newCount > 0 && (
                <span className={`nav-badge ${count.data?.bySeverity.HIGH ? 'nav-badge-high' : ''}`}>{newCount}</span>
              )}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <div className="who">{user.fullName}<span>{ROLE[user.role]}</span></div>
          {user.role === 'SUPERADMIN' && auth.orgId && (
            <button className="link" onClick={() => { auth.setOrg(null); go('/orgs'); }}>Сменить хозяйство</button>
          )}
          <button className="link" onClick={logout}>Выйти</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="Меню" onClick={() => setMenuOpen((v) => !v)}>☰</button>
          <span className="topbar-title">АгроКонтроль</span>
        </header>
        <main className="content">{children}</main>
      </div>
      <Toasts />
    </div>
  );
}

/** Для отладки из консоли браузера */
(window as any).agroApi = api;
