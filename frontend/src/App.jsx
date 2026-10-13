/**
 * App.jsx
 * Page routing. Every page is wrapped in RequirePermission, which shows a
 * friendly "no access" message if the role lacks the permission. That is UX
 * only: the backend independently returns 403 for the same requests.
 */
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { AlertStreamProvider } from './alertStream';
import Layout from './components/Layout';
import { Lock } from 'lucide-react';
import { Callout, PageHead } from './components/Common';
import Overview from './pages/Overview';
import LiveAlerts from './pages/LiveAlerts';
import Reports from './pages/Reports';
import ReportDetail from './pages/ReportDetail';
import Orphaned from './pages/Orphaned';
import Costs from './pages/Costs';
import DataQuality from './pages/DataQuality';
import Users from './pages/Users';

// The login page's animation libraries (motion, WebGL fibres) load only when it is shown.
const Login = lazy(() => import('./pages/Login'));

function RequirePermission({ permission, children }) {
  const { user, can } = useAuth();
  if (can(permission)) return children;
  return (
    <>
      <PageHead title="No access" />
      <Callout tone="warning" icon={Lock}>
        Your role (<strong className="text-foreground">{user.role}</strong>) does not have the <code>{permission}</code> permission needed for this page.
        The server would also refuse the request with <code>403 Forbidden</code>.
      </Callout>
    </>
  );
}

function ProtectedApp() {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <AlertStreamProvider>
      <Layout />
    </AlertStreamProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Suspense fallback={null}><Login /></Suspense>} />
      <Route element={<ProtectedApp />}>
        <Route index element={<RequirePermission permission="health:read"><Overview /></RequirePermission>} />
        <Route path="alerts" element={<RequirePermission permission="alerts:read"><LiveAlerts /></RequirePermission>} />
        <Route path="reports" element={<RequirePermission permission="reports:read"><Reports /></RequirePermission>} />
        <Route path="reports/:id" element={<RequirePermission permission="reports:read"><ReportDetail /></RequirePermission>} />
        <Route path="orphaned" element={<RequirePermission permission="reports:read"><Orphaned /></RequirePermission>} />
        <Route path="costs" element={<RequirePermission permission="costs:read"><Costs /></RequirePermission>} />
        <Route path="data-quality" element={<RequirePermission permission="dataquality:read"><DataQuality /></RequirePermission>} />
        <Route path="users" element={<RequirePermission permission="users:read"><Users /></RequirePermission>} />
        <Route path="*" element={<PageHead title="Page not found" subtitle="Use the menu on the left." />} />
      </Route>
    </Routes>
  );
}
