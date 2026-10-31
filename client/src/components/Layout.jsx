import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Briefcase, PlusCircle, BookOpen, LogOut, BarChart3, FileStack, Settings, FolderKanban,
  Boxes, Warehouse, ClipboardCheck, ChevronDown, ChevronRight, List, SlidersHorizontal, Table, Gauge, Package, Users,
  ClipboardList, Truck, MapPin, QrCode, Calculator, Layers, Clock, CheckSquare, FileCheck2, Menu, X,
  DollarSign, ShoppingBag, Wrench, PieChart, ListChecks, History,
} from 'lucide-react';
import api from '../api';
import RefreshButton from './RefreshButton';
import { useAuth, canUseModule } from '../context/AuthContext';
import WhoIsOnline from './WhoIsOnline';
import InstallApp from './InstallApp';

// The side menu is three sections — ITF Work Desk, ITF Asset Tracker and ITF
// Storage Centre — each opening to show its own pages, then Settings.
const DESK_PATHS = ['/dashboard', '/jobs', '/projects', '/reports', '/templates', '/kb'];
const inDesk = (p) => DESK_PATHS.some((d) => p === d || p.startsWith(`${d}/`));
const sectionOf = (p) => (p.startsWith('/checklist') ? 'checklist' : p.startsWith('/sales') ? 'sales' : p.startsWith('/storage') ? 'storage' : p.startsWith('/assets') ? 'assets' : p.startsWith('/timecard') ? 'timecard' : inDesk(p) ? 'desk' : null);

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
  const isContractor = user?.role === 'contractor';
  const current = sectionOf(location.pathname);
  // Phones: the menu folds away behind a Menu button so pages start at the top.
  const [menuOpen, setMenuOpen] = useState(false);

  // The section you're in is always open; others open/close when clicked.
  const [open, setOpen] = useState(() => ({ desk: current === 'desk', assets: current === 'assets', storage: current === 'storage', sales: current === 'sales', checklist: current === 'checklist', timecard: current === 'timecard' }));

  // Admins: how many timesheets are waiting on approval (shown in the menu).
  const [tcPending, setTcPending] = useState(0);
  useEffect(() => {
    if (!isAdmin || user?.approvesTimecard === false) return undefined;
    const load = () => api.get('/timecard/admin/pending-count').then((r) => setTcPending(r.data.count)).catch(() => {});
    load();
    window.addEventListener('timecard:changed', load);
    return () => window.removeEventListener('timecard:changed', load);
  }, [isAdmin, user?.approvesTimecard]);
  // Sales Manager: Shopify order lines waiting for review (shown in the menu).
  const canSales = canUseModule(user, 'sales');
  const [salesPending, setSalesPending] = useState(0);
  useEffect(() => {
    if (!canSales) return;
    api.get('/sales/shopify/pending').then((r) => setSalesPending(r.data.orders.length)).catch(() => {});
  }, [canSales, location.pathname]);
  // Casuals: show "My Jobs" / "My Projects" once work has been assigned to them.
  const [casualWork, setCasualWork] = useState({ jobs: false, projects: false });
  useEffect(() => {
    if (!isContractor) return;
    Promise.all([
      api.get('/jobs').then((r) => (r.data.jobs || []).length > 0).catch(() => false),
      api.get('/projects').then((r) => (r.data.projects || []).length > 0).catch(() => false),
    ]).then(([jobs, projects]) => {
      setCasualWork({ jobs, projects });
      if (jobs || projects) setOpen((o) => ({ ...o, desk: true }));
    });
  }, [isContractor]);
  useEffect(() => { if (current) setOpen((o) => (o[current] ? o : { ...o, [current]: true })); }, [current]);
  const toggle = (id, value) => setOpen((o) => ({ ...o, [id]: value }));

  return (
    <div className="app-shell">
      <aside className={'sidebar' + (menuOpen ? ' open' : '')}>
        <div className="sidebar-brand">
          <img src="/logo-sidebar-light.png" alt="IT Factory" className="brand-logo" />
          <span>Work Desk</span>
          <RefreshButton />
          <button type="button" className="menu-toggle" aria-expanded={menuOpen} aria-controls="main-menu"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'} onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
            <span>{menuOpen ? 'Close' : 'Menu'}</span>
          </button>
        </div>
        {/* Picking a page closes the phone menu (section headings just open/close). */}
        <nav className="sidebar-nav" id="main-menu" onClick={(e) => { if (e.target.closest('a')) setMenuOpen(false); }}>
          {/* ITF Casuals: their timesheet, plus any sections an admin switched on. */}
          {isContractor && (
          <Section id="timecard" title="ITF Time Card" icon={Clock} home="/timecard"
            open={open.timecard} current={current === 'timecard'} onToggle={toggle}>
            <NavLink to="/timecard" end className={linkClass}><Clock size={14} /> My Timesheet</NavLink>
          </Section>
          )}
          {isContractor && (casualWork.jobs || casualWork.projects || current === 'desk') && (
          <Section id="desk" title="ITF Work Desk" icon={ClipboardCheck} home={casualWork.jobs || !casualWork.projects ? '/jobs' : '/projects'}
            open={open.desk} current={current === 'desk'} onToggle={toggle}>
            {(casualWork.jobs || location.pathname.startsWith('/jobs')) && <NavLink to="/jobs" className={linkClass}><Briefcase size={14} /> My Jobs</NavLink>}
            {(casualWork.projects || location.pathname.startsWith('/projects')) && <NavLink to="/projects" className={linkClass}><FolderKanban size={14} /> My Projects</NavLink>}
          </Section>
          )}

          {!isContractor && (
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
          )}

          {canUseModule(user, 'assets') && (
          <Section id="assets" title="ITF Asset Tracker" icon={Boxes} home="/assets"
            open={open.assets} current={current === 'assets'} onToggle={toggle}>
            {isAdmin && <NavLink to="/assets/dashboard" className={linkClass}><Gauge size={14} /> Dashboard</NavLink>}
            <NavLink to="/assets" end className={linkClass}><List size={14} /> All Assets</NavLink>
            {isAdmin && <NavLink to="/assets/batches" className={linkClass}><Layers size={14} /> Batches</NavLink>}
            {isAdmin && <NavLink to="/assets/fields" className={linkClass}><SlidersHorizontal size={14} /> Manage Fields</NavLink>}
          </Section>
          )}

          {canUseModule(user, 'storage') && (
          <Section id="storage" title="ITF Storage Centre" icon={Warehouse} home="/storage/dashboard"
            open={open.storage} current={current === 'storage'} onToggle={toggle}>
            <NavLink to="/storage/dashboard" className={linkClass}><Gauge size={14} /> Dashboard</NavLink>
            <NavLink to="/storage" end className={linkClass}><Table size={14} /> Manifest</NavLink>
            <NavLink to="/storage/pallets" className={linkClass}><Package size={14} /> Pallets</NavLink>
            <NavLink to="/storage/orders" className={linkClass}><ClipboardList size={14} /> Client Orders</NavLink>
            <NavLink to="/storage/receiving" className={linkClass}><Truck size={14} /> Receiving / Dispatch</NavLink>
            <NavLink to="/storage/locations" className={linkClass}><MapPin size={14} /> Locations</NavLink>
            <NavLink to="/storage/labels" className={linkClass}><QrCode size={14} /> Pallet Labels</NavLink>
            <NavLink to="/storage/calculator" className={linkClass}><Calculator size={14} /> Calculator</NavLink>
            {isAdmin && <NavLink to="/storage/reports" className={linkClass}><BarChart3 size={14} /> Reports</NavLink>}
          </Section>
          )}

          {canSales && (
          <Section id="sales" title="ITF Sales Manager" icon={DollarSign} home="/sales"
            open={open.sales} current={current === 'sales'} onToggle={toggle}>
            <NavLink to="/sales" end className={linkClass}><Gauge size={14} /> Dashboard</NavLink>
            <NavLink to="/sales/add" className={linkClass}><PlusCircle size={14} /> Add a Sale</NavLink>
            <NavLink to="/sales/all" className={() => linkClass({ isActive: location.pathname === '/sales/all' || location.pathname.startsWith('/sales/edit') })}><Table size={14} /> All Sales</NavLink>
            <NavLink to="/sales/inventory" className={linkClass}><Package size={14} /> Inventory on Hand</NavLink>
            <NavLink to="/sales/shopify" className={linkClass}><ShoppingBag size={14} /> Shopify Orders{salesPending > 0 && <span className="tc-navcount">{salesPending}</span>}</NavLink>
            <NavLink to="/sales/products" className={linkClass}><PieChart size={14} /> Sales by Product</NavLink>
            <NavLink to="/sales/models" className={linkClass}><Layers size={14} /> Inventory by Model</NavLink>
            <NavLink to="/sales/reports" className={linkClass}><BarChart3 size={14} /> Reports</NavLink>
            <NavLink to="/sales/tools" className={linkClass}><Wrench size={14} /> Tools</NavLink>
          </Section>
          )}

          {canUseModule(user, 'checklist') && (
          <Section id="checklist" title="ITF Asset Checklist" icon={ListChecks} home="/checklist"
            open={open.checklist} current={current === 'checklist'} onToggle={toggle}>
            <NavLink to="/checklist/dashboard" className={linkClass}><Gauge size={14} /> Dashboard</NavLink>
            <NavLink to="/checklist" end className={() => linkClass({ isActive: location.pathname === '/checklist' || location.pathname.startsWith('/checklist/new') })}><PlusCircle size={14} /> New Checklist</NavLink>
            <NavLink to="/checklist/history" className={() => linkClass({ isActive: location.pathname.startsWith('/checklist/history') || location.pathname.startsWith('/checklist/edit') })}><History size={14} /> Saved History</NavLink>
            {isAdmin && <NavLink to="/checklist/tools" className={linkClass}><Wrench size={14} /> Tools</NavLink>}
          </Section>
          )}

          {!isContractor && <>
          {!isAdmin && user?.accessTimecard && (
          <Section id="timecard" title="ITF Time Card" icon={Clock} home="/timecard"
            open={open.timecard} current={current === 'timecard'} onToggle={toggle}>
            <NavLink to="/timecard" end className={linkClass}><Clock size={14} /> My Timesheet</NavLink>
          </Section>
          )}

          {isAdmin && canUseModule(user, 'timecard') && (
          <Section id="timecard" title="ITF Time Card" icon={Clock} home="/timecard/dashboard"
            open={open.timecard} current={current === 'timecard'} onToggle={toggle}>
            <NavLink to="/timecard/dashboard" className={linkClass}><Gauge size={14} /> Dashboard</NavLink>
            <NavLink to="/timecard/approvals" className={linkClass}><CheckSquare size={14} /> Approvals{tcPending > 0 && <span className="tc-navcount">{tcPending}</span>}</NavLink>
            <NavLink to="/timecard/approved" className={linkClass}><FileCheck2 size={14} /> Approved</NavLink>
            <NavLink to="/timecard/reports" className={linkClass}><BarChart3 size={14} /> Reports</NavLink>
          </Section>
          )}
          </>}

          {/* Clients (portal logins) — shared by Storage Centre and Asset Tracker. */}
          {(isAdmin || canUseModule(user, 'storage') || canUseModule(user, 'assets')) && (
            <NavLink to="/clients" className={({ isActive }) => 'sidebar-link sidebar-settings' + (isActive ? ' active' : '')}>
              <Users size={16} /> Clients
            </NavLink>
          )}
          {isAdmin && (
            <NavLink to="/settings" className={({ isActive }) => 'sidebar-link sidebar-settings' + (isActive ? ' active' : '')}>
              <Settings size={16} /> Settings
            </NavLink>
          )}
        </nav>
        <div className="sidebar-footer">
          {!isContractor && <WhoIsOnline me={user?.name} meId={user?.id} isAdmin={user?.role === 'admin' || user?.role === 'agent'} />}
          <InstallApp />
          <button onClick={() => logout()}><LogOut size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Log out</button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
