import { HashRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import FieldApp from './field/FieldApp';
import Dashboard from './dashboard/Dashboard';

// HashRouter: required for Capacitor file:// URLs (BrowserRouter breaks on device).
function EnvNav() {
  const loc = useLocation();
  const onField = !loc.pathname.startsWith('/dashboard');
  return (
    <nav className="env-nav">
      <Link to="/" className={onField ? 'active' : ''}>
        Field app
      </Link>
      <Link to="/dashboard" className={!onField ? 'active' : ''}>
        Operations dashboard
      </Link>
    </nav>
  );
}

export default function App() {
  return (
    <HashRouter>
      <EnvNav />
      <Routes>
        <Route path="/dashboard/*" element={<Dashboard />} />
        <Route path="/*" element={<FieldApp />} />
      </Routes>
    </HashRouter>
  );
}
