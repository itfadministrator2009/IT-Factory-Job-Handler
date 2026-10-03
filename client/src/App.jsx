import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import JobList from './pages/JobList';
import JobDetail from './pages/JobDetail';
import JobForm from './pages/JobForm';
import KnowledgeBase from './pages/KnowledgeBase';
import ArticleView from './pages/ArticleView';
import ArticleForm from './pages/ArticleForm';
import Reports from './pages/Reports';
import Templates from './pages/Templates';
import Settings from './pages/Settings';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import ProjectEntryForm from './pages/ProjectEntryForm';
import AssetTracker from './pages/AssetTracker';
import AssetReports from './pages/AssetReports';
import AssetFields from './pages/AssetFields';
import StorageManifest from './pages/StorageManifest';
import StoragePallets from './pages/StoragePallets';
import StorageClients from './pages/StorageClients';
import StorageOrders from './pages/StorageOrders';
import StorageReceiving from './pages/StorageReceiving';
import StorageReports from './pages/StorageReports';
import StorageLocations from './pages/StorageLocations';
import StorageDashboard from './pages/StorageDashboard';
import StorageCalculator from './pages/StorageCalculator';
import StoragePalletLabels from './pages/StoragePalletLabels';
import PortalLogin from './pages/PortalLogin';
import Portal from './pages/Portal';
import { hasPortalSession } from './portal/portalApi';

// Keeps the page you asked for (e.g. a scanned pallet label) so login can
// send you back to it.
function RequireAuth({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return children;
}

function RequireAdmin({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  const isAdmin = user.role === 'admin' || user.role === 'agent';
  if (!isAdmin) return <Navigate to="/jobs" replace />;
  return children;
}

// Storage Centre client portal — uses its own client login, not the staff one.
function RequirePortal({ children }) {
  if (!hasPortalSession()) return <Navigate to="/portal/login" replace />;
  return children;
}

function HomeRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  const isAdmin = user.role === 'admin' || user.role === 'agent';
  return <Navigate to={isAdmin ? '/dashboard' : '/jobs'} replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      <Route path="/portal/login" element={<PortalLogin />} />
      <Route path="/portal" element={<RequirePortal><Portal /></RequirePortal>} />
      <Route path="/portal/*" element={<Navigate to="/portal" replace />} />

      <Route path="/dashboard" element={<RequireAdmin><Dashboard /></RequireAdmin>} />
      <Route path="/jobs" element={<RequireAuth><JobList /></RequireAuth>} />
      <Route path="/jobs/new" element={<RequireAdmin><JobForm /></RequireAdmin>} />
      <Route path="/jobs/:id/edit" element={<RequireAuth><JobForm /></RequireAuth>} />
      <Route path="/jobs/:id" element={<RequireAuth><JobDetail /></RequireAuth>} />

      <Route path="/reports" element={<RequireAdmin><Reports /></RequireAdmin>} />
      <Route path="/templates" element={<RequireAdmin><Templates /></RequireAdmin>} />
      <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />

      <Route path="/projects" element={<RequireAuth><Projects /></RequireAuth>} />
      <Route path="/projects/:id" element={<RequireAuth><ProjectDetail /></RequireAuth>} />
      <Route path="/projects/:id/entries/:entryId" element={<RequireAuth><ProjectEntryForm /></RequireAuth>} />

      <Route path="/assets" element={<RequireAuth><AssetTracker /></RequireAuth>} />
      <Route path="/assets/reports" element={<RequireAdmin><AssetReports /></RequireAdmin>} />
      <Route path="/assets/fields" element={<RequireAdmin><AssetFields /></RequireAdmin>} />

      <Route path="/storage" element={<RequireAuth><StorageManifest /></RequireAuth>} />
      <Route path="/storage/pallets" element={<RequireAuth><StoragePallets /></RequireAuth>} />
      <Route path="/storage/clients" element={<RequireAuth><StorageClients /></RequireAuth>} />
      <Route path="/storage/orders" element={<RequireAuth><StorageOrders /></RequireAuth>} />
      <Route path="/storage/receiving" element={<RequireAuth><StorageReceiving /></RequireAuth>} />
      <Route path="/storage/locations" element={<RequireAuth><StorageLocations /></RequireAuth>} />
      <Route path="/storage/reports" element={<RequireAdmin><StorageReports /></RequireAdmin>} />
      <Route path="/storage/dashboard" element={<RequireAuth><StorageDashboard /></RequireAuth>} />
      <Route path="/storage/calculator" element={<RequireAuth><StorageCalculator /></RequireAuth>} />
      <Route path="/storage/labels" element={<RequireAuth><StoragePalletLabels /></RequireAuth>} />

      <Route path="/kb" element={<RequireAuth><KnowledgeBase /></RequireAuth>} />
      <Route path="/kb/new" element={<RequireAuth><ArticleForm /></RequireAuth>} />
      <Route path="/kb/:id/edit" element={<RequireAuth><ArticleForm /></RequireAuth>} />
      <Route path="/kb/:slug" element={<RequireAuth><ArticleView /></RequireAuth>} />

      <Route path="/" element={<HomeRedirect />} />
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
