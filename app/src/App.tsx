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
      <span className="brandmark" aria-label="Strinteg">
        <span className="str">STR</span>INTEG
      </span>
      <Link to="/" className={`env-link${active === 'field' ? ' active' : ''}`}>
        Field app
      </Link>
      <Link
        to="/dashboard"
        className={`env-link${active === 'firm' ? ' active' : ''}`}
      >
        Firm ops
      </Link>
      <Link
        to="/statedashboard"
        className={`env-link${active === 'state' ? ' active' : ''}`}
      >
        State ops
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
