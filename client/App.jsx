import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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

function RequireAuth({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function RequireAdmin({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  const isAdmin = user.role === 'admin' || user.role === 'agent';
  if (!isAdmin) return <Navigate to="/jobs" replace />;
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

      <Route path="/dashboard" element={<RequireAdmin><Dashboard /></RequireAdmin>} />
      <Route path="/jobs" element={<RequireAuth><JobList /></RequireAuth>} />
      <Route path="/jobs/new" element={<RequireAdmin><JobForm /></RequireAdmin>} />
      <Route path="/jobs/:id/edit" element={<RequireAuth><JobForm /></RequireAuth>} />
      <Route path="/jobs/:id" element={<RequireAuth><JobDetail /></RequireAuth>} />

      <Route path="/reports" element={<RequireAdmin><Reports /></RequireAdmin>} />
      <Route path="/templates" element={<RequireAdmin><Templates /></RequireAdmin>} />
      <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />

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
