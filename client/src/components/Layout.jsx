import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Briefcase, PlusCircle, BookOpen, LogOut, BarChart3, FileStack, Settings } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-logo-badge"><img src="/logo.jpg" alt="IT Factory" /></span>
          <span>Work Desk</span>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/dashboard" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
            <LayoutDashboard size={16} /> Dashboard
          </NavLink>
          <NavLink to="/jobs" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
            <Briefcase size={16} /> Jobs
          </NavLink>
          <NavLink to="/jobs/new" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
            <PlusCircle size={16} /> New Job
          </NavLink>
          <NavLink to="/reports" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
            <BarChart3 size={16} /> Reports
          </NavLink>
          <NavLink to="/templates" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
            <FileStack size={16} /> Templates
          </NavLink>
          <NavLink to="/kb" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
            <BookOpen size={16} /> Knowledge Base
          </NavLink>
          {isAdmin && (
            <NavLink to="/settings" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
              <Settings size={16} /> Settings
            </NavLink>
          )}
        </nav>
        <div className="sidebar-footer">
          <div>{user?.name}</div>
          <button onClick={logout}><LogOut size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Log out</button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
