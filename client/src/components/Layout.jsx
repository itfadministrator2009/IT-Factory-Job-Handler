import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Briefcase, PlusCircle, BookOpen, LogOut, BarChart3, FileStack, Settings, FolderKanban,
  Boxes, Warehouse, ClipboardCheck, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import WhoIsOnline from './WhoIsOnline';

// The side menu is three sections — ITF Work Desk, ITF Asset Tracker and ITF
// Storage Centre — each opening to show its own pages, then Settings.
const DESK_PATHS = ['/dashboard', '/jobs', '/projects', '/reports', '/templates', '/kb'];
const inDesk = (p) => DESK_PATHS.some((d) => p === d || p.startsWith(`${d}/`));
const sectionOf = (p) => (p.startsWith('/storage') ? 'storage' : p.startsWith('/assets') ? 'assets' : inDesk(p) ? 'desk' : null);

const linkClass = ({ isActive }) => `sidebar-link sidebar-sublink${isActive ? ' active' : ''}`;

function Section({ id, title, icon: Icon, home, open, current, onToggle, children }) {
  const navigate = useNavigate();
  return (
    <div className="sidebar-section">
      <button type="button" className={`sidebar-link sidebar-section-head${current ? ' current' : ''}`} aria-expanded={open}
        onClick={() => { if (open && current) onToggle(id, false); else { onToggle(id, true); if (!current) navigate(home); } }}>
        <Icon size={16} />
        <span style={{ flex: 1, textAlign: 'left' }}>{title}</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && <div className="sidebar-subnav">{children}</div>}
    </div>
  );
}

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const current = sectionOf(location.pathname);

  // The section you're in is always open; others open/close when clicked.
  const [open, setOpen] = useState(() => ({ desk: current === 'desk', assets: current === 'assets', storage: current === 'storage' }));
  useEffect(() => { if (current) setOpen((o) => (o[current] ? o : { ...o, [current]: true })); }, [current]);
  const toggle = (id, value) => setOpen((o) => ({ ...o, [id]: value }));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src="/logo-sidebar.png" alt="IT Factory" className="brand-logo" />
          <span>Work Desk</span>
        </div>
        <nav className="sidebar-nav">
          <Section id="desk" title="ITF Work Desk" icon={ClipboardCheck} home={isAdmin ? '/dashboard' : '/jobs'}
            open={open.desk} current={current === 'desk'} onToggle={toggle}>
            {isAdmin && <NavLink to="/dashboard" className={linkClass}><LayoutDashboard size={14} /> Dashboard</NavLink>}
            <NavLink to="/jobs" className={() => linkClass({ isActive: location.pathname.startsWith('/jobs') && location.pathname !== '/jobs/new' })}><Briefcase size={14} /> Jobs</NavLink>
            {isAdmin && <NavLink to="/jobs/new" className={linkClass}><PlusCircle size={14} /> New Job</NavLink>}
            <NavLink to="/projects" className={linkClass}><FolderKanban size={14} /> Projects</NavLink>
            {isAdmin && <NavLink to="/reports" className={linkClass}><BarChart3 size={14} /> Reports</NavLink>}
            {isAdmin && <NavLink to="/templates" className={linkClass}><FileStack size={14} /> Templates</NavLink>}
            <NavLink to="/kb" className={linkClass}><BookOpen size={14} /> Knowledge Base</NavLink>
          </Section>

          <Section id="assets" title="ITF Asset Tracker" icon={Boxes} home="/assets"
            open={open.assets} current={current === 'assets'} onToggle={toggle}>
            <NavLink to="/assets" end className={linkClass}>All Assets</NavLink>
            {isAdmin && <NavLink to="/assets/reports" className={linkClass}>Reports</NavLink>}
            {isAdmin && <NavLink to="/assets/fields" className={linkClass}>Manage Fields</NavLink>}
          </Section>

          <Section id="storage" title="ITF Storage Centre" icon={Warehouse} home="/storage"
            open={open.storage} current={current === 'storage'} onToggle={toggle}>
            <NavLink to="/storage/dashboard" className={linkClass}>Dashboard</NavLink>
            <NavLink to="/storage" end className={linkClass}>Manifest</NavLink>
            <NavLink to="/storage/pallets" className={linkClass}>Pallets</NavLink>
            <NavLink to="/storage/clients" className={linkClass}>Clients</NavLink>
            <NavLink to="/storage/orders" className={linkClass}>Client Orders</NavLink>
            <NavLink to="/storage/receiving" className={linkClass}>Receiving / Dispatch</NavLink>
            <NavLink to="/storage/locations" className={linkClass}>Locations</NavLink>
            <NavLink to="/storage/labels" className={linkClass}>Pallet Labels</NavLink>
            <NavLink to="/storage/calculator" className={linkClass}>Calculator</NavLink>
            {isAdmin && <NavLink to="/storage/reports" className={linkClass}>Reports</NavLink>}
          </Section>

          {isAdmin && (
            <NavLink to="/settings" className={({ isActive }) => 'sidebar-link sidebar-settings' + (isActive ? ' active' : '')}>
              <Settings size={16} /> Settings
            </NavLink>
          )}
        </nav>
        <div className="sidebar-footer">
          <WhoIsOnline me={user?.name} />
          <button onClick={logout}><LogOut size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Log out</button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
