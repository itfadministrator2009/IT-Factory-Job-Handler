import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth, canUseModule } from './context/AuthContext';
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
import SalesDashboard from './pages/SalesDashboard';
import SalesList from './pages/SalesList';
import SalesItemForm from './pages/SalesItemForm';
import SalesGrouped from './pages/SalesGrouped';
import SalesReports from './pages/SalesReports';
import SalesShopify from './pages/SalesShopify';
import SalesTools from './pages/SalesTools';
import StoragePallets from './pages/StoragePallets';
import StorageClients from './pages/StorageClients';
import StorageOrders from './pages/StorageOrders';
import StorageReceiving from './pages/StorageReceiving';
import StorageReports from './pages/StorageReports';
import StorageLocations from './pages/StorageLocations';
import StorageDashboard from './pages/StorageDashboard';
import StorageCalculator from './pages/StorageCalculator';
import StoragePalletLabels from './pages/StoragePalletLabels';
import StorageRestore from './pages/StorageRestore';
import RecordRestore from './pages/RecordRestore';
import AssetBatches from './pages/AssetBatches';
import TimeCard from './pages/TimeCard';
import TimeCardAdmin from './pages/TimeCardAdmin';
import PortalLogin from './pages/PortalLogin';
import Portal from './pages/Portal';
import { hasPortalSession } from './portal/portalApi';

// Keeps the page you asked for (e.g. a scanned pallet label) so login can
// send you back to it.
function RequireAuth({ children, casualsToo }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  // Casuals use ITF Time Card — plus Jobs and Projects assigned to them.
  if (user.role === 'contractor' && !casualsToo) return <Navigate to="/timecard" replace />;
  return children;
}

// ITF Time Card: contractors (and Users with Time Card ticked) get their timesheet;
// admins get approvals.
function RequireTimecard({ adminView, children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  const isAdmin = user.role === 'admin' || user.role === 'agent';
  if (user.role === 'contractor') return adminView ? <Navigate to="/timecard" replace /> : children;
  if (!isAdmin) {
    if (!user.accessTimecard) return <Navigate to="/jobs" replace />;
    return adminView ? <Navigate to="/timecard" replace /> : children;
  }
  // Admins: unless the Super Admin has switched ITF Time Card off for them.
  if (user.approvesTimecard === false) return <Navigate to="/dashboard" replace />;
  return adminView ? children : <Navigate to="/timecard/dashboard" replace />;
}

// ITF Asset Tracker / ITF Storage Centre pages: only for users with access.
function RequireModule({ module, children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (!canUseModule(user, module)) return <Navigate to={user.role === 'contractor' ? '/timecard' : '/jobs'} replace />;
  return children;
}

function RequireAdmin({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  const isAdmin = user.role === 'admin' || user.role === 'agent';
  if (!isAdmin) return <Navigate to={user.role === 'contractor' ? '/timecard' : '/jobs'} replace />;
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
  if (user.role === 'contractor') return <Navigate to="/timecard" replace />;
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
      <Route path="/jobs" element={<RequireAuth casualsToo><JobList /></RequireAuth>} />
      <Route path="/jobs/new" element={<RequireAdmin><JobForm /></RequireAdmin>} />
      <Route path="/jobs/:id/edit" element={<RequireAuth casualsToo><JobForm /></RequireAuth>} />
      <Route path="/jobs/:id" element={<RequireAuth casualsToo><JobDetail /></RequireAuth>} />

      <Route path="/reports" element={<RequireAdmin><Reports /></RequireAdmin>} />
      <Route path="/templates" element={<RequireAdmin><Templates /></RequireAdmin>} />
      <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />

      <Route path="/projects" element={<RequireAuth casualsToo><Projects /></RequireAuth>} />
      <Route path="/projects/:id" element={<RequireAuth casualsToo><ProjectDetail /></RequireAuth>} />
      <Route path="/projects/:id/entries/:entryId" element={<RequireAuth casualsToo><ProjectEntryForm /></RequireAuth>} />

      <Route path="/assets" element={<RequireModule module="assets"><AssetTracker /></RequireModule>} />
      <Route path="/assets/reports" element={<RequireAdmin><AssetReports /></RequireAdmin>} />
      <Route path="/assets/fields" element={<RequireAdmin><AssetFields /></RequireAdmin>} />
      <Route path="/assets/batches" element={<RequireModule module="assets"><AssetBatches /></RequireModule>} />
      <Route path="/assets/batches/:id" element={<RequireModule module="assets"><AssetBatches /></RequireModule>} />

      <Route path="/sales" element={<RequireModule module="sales"><SalesDashboard /></RequireModule>} />
      <Route path="/sales/all" element={<RequireModule module="sales"><SalesList kind="sale" /></RequireModule>} />
      <Route path="/sales/add" element={<RequireModule module="sales"><SalesItemForm kind="sale" key="sale-add" /></RequireModule>} />
      <Route path="/sales/edit/:id" element={<RequireModule module="sales"><SalesItemForm kind="sale" /></RequireModule>} />
      <Route path="/sales/inventory" element={<RequireModule module="sales"><SalesList kind="inventory" /></RequireModule>} />
      <Route path="/sales/inventory/add" element={<RequireModule module="sales"><SalesItemForm kind="inventory" key="inv-add" /></RequireModule>} />
      <Route path="/sales/inventory/edit/:id" element={<RequireModule module="sales"><SalesItemForm kind="inventory" /></RequireModule>} />
      <Route path="/sales/products" element={<RequireModule module="sales"><SalesGrouped mode="products" /></RequireModule>} />
      <Route path="/sales/models" element={<RequireModule module="sales"><SalesGrouped mode="models" /></RequireModule>} />
      <Route path="/sales/reports" element={<RequireModule module="sales"><SalesReports /></RequireModule>} />
      <Route path="/sales/shopify" element={<RequireModule module="sales"><SalesShopify /></RequireModule>} />
      <Route path="/sales/tools" element={<RequireModule module="sales"><SalesTools /></RequireModule>} />
      <Route path="/storage" element={<RequireModule module="storage"><StorageManifest /></RequireModule>} />
      <Route path="/storage/pallets" element={<RequireModule module="storage"><StoragePallets /></RequireModule>} />
      <Route path="/storage/clients" element={<RequireModule module="storage"><StorageClients /></RequireModule>} />
      <Route path="/storage/orders" element={<RequireModule module="storage"><StorageOrders /></RequireModule>} />
      <Route path="/storage/receiving" element={<RequireModule module="storage"><StorageReceiving /></RequireModule>} />
      <Route path="/storage/locations" element={<RequireModule module="storage"><StorageLocations /></RequireModule>} />
      <Route path="/storage/reports" element={<RequireAdmin><StorageReports /></RequireAdmin>} />
      <Route path="/storage/dashboard" element={<RequireModule module="storage"><StorageDashboard /></RequireModule>} />
      <Route path="/storage/calculator" element={<RequireModule module="storage"><StorageCalculator /></RequireModule>} />
      <Route path="/storage/labels" element={<RequireModule module="storage"><StoragePalletLabels /></RequireModule>} />
      <Route path="/storage/restore" element={<RequireAdmin><StorageRestore /></RequireAdmin>} />
      <Route path="/restore-records" element={<RequireAdmin><RecordRestore /></RequireAdmin>} />

      <Route path="/timecard" element={<RequireTimecard><TimeCard /></RequireTimecard>} />
      <Route path="/timecard/approvals" element={<RequireTimecard adminView><TimeCardAdmin view="approvals" /></RequireTimecard>} />
      <Route path="/timecard/dashboard" element={<RequireTimecard adminView><TimeCardAdmin view="dashboard" /></RequireTimecard>} />
      <Route path="/timecard/approved" element={<RequireTimecard adminView><TimeCardAdmin view="approved" /></RequireTimecard>} />
      <Route path="/timecard/reports" element={<RequireTimecard adminView><TimeCardAdmin view="reports" /></RequireTimecard>} />

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
