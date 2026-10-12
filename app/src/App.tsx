import { HashRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import FieldApp from './field/FieldApp';
import Dashboard from './dashboard/Dashboard';
import StateDashboard from './dashboard/StateDashboard';

// HashRouter: required for Capacitor file:// URLs (BrowserRouter breaks on device).
function EnvNav() {
  const loc = useLocation();
  const path = loc.pathname;
  const active = path.startsWith('/statedashboard')
    ? 'state'
    : path.startsWith('/dashboard')
      ? 'firm'
      : 'field';
  return (
    <nav className="env-nav">
      <Link to="/" className={active === 'field' ? 'active' : ''}>
        Field app
      </Link>
      <Link to="/dashboard" className={active === 'firm' ? 'active' : ''}>
        Operations dashboard
      </Link>
      <Link to="/statedashboard" className={active === 'state' ? 'active' : ''}>
        State dashboard
      </Link>
    </nav>
  );
}

export default function App() {
  return (
    <HashRouter>
      <EnvNav />
      <Routes>
        <Route path="/statedashboard/*" element={<StateDashboard />} />
        <Route path="/dashboard/*" element={<Dashboard />} />
        <Route path="/*" element={<FieldApp />} />
      </Routes>
    </HashRouter>
  );
}
