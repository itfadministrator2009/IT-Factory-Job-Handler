import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import api from '../api';
import { resetPresence } from '../components/WhoIsOnline';

const AuthContext = createContext(null);

// "Remember this device" for two-step login. Kept when logging out, so the next
// login on this browser doesn't ask for a code (for 30 days).
const DEVICE_KEY = 'helpdesk_device_token';
function getDeviceToken() {
  try { return localStorage.getItem(DEVICE_KEY); } catch (e) { return null; }
}
export function forgetThisDevice() {
  try { localStorage.removeItem(DEVICE_KEY); } catch (e) { /* nothing saved */ }
}
// A readable name for the trusted-devices list, e.g. "Chrome on Windows".
function deviceLabel() {
  const ua = navigator.userAgent || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'device';
  return `${browser} on ${os}`;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('helpdesk_user');
    return stored ? JSON.parse(stored) : null;
  });

  // Pick up role / section-access changes made in Settings without signing out.
  useEffect(() => {
    if (!localStorage.getItem('helpdesk_token')) return;
    api.get('/auth/me').then(({ data }) => {
      if (!data?.user) return;
      localStorage.setItem('helpdesk_user', JSON.stringify(data.user));
      setUser(data.user);
    }).catch(() => {});
  }, []);

  const finishLogin = useCallback((data) => {
    localStorage.setItem('helpdesk_token', data.token);
    localStorage.setItem('helpdesk_user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }, []);

  // Admins may be asked for an emailed code first: then this returns
  // { twoStep: true, challengeId, sentTo } and the page calls verifyCode.
  const login = useCallback(async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password, deviceToken: getDeviceToken() || undefined });
    if (data.twoStep) return data;
    return finishLogin(data);
  }, [finishLogin]);

  const verifyCode = useCallback(async (challengeId, code, remember) => {
    const { data } = await api.post('/auth/login/verify', { challengeId, code, remember, deviceLabel: deviceLabel() });
    if (data.deviceToken) { try { localStorage.setItem(DEVICE_KEY, data.deviceToken); } catch (e) { /* not remembered */ } }
    return finishLogin(data);
  }, [finishLogin]);

  const register = useCallback(async (name, email, password) => {
    const { data } = await api.post('/auth/register', { name, email, password });
    localStorage.setItem('helpdesk_token', data.token);
    localStorage.setItem('helpdesk_user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    // Drop off the "online now" list straight away (the token is read now,
    // before it's removed below).
    const token = localStorage.getItem('helpdesk_token');
    if (token) api.delete('/presence', { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    resetPresence();
    localStorage.removeItem('helpdesk_token');
    localStorage.removeItem('helpdesk_user');
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, login, verifyCode, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// Can this user open the ITF Asset Tracker ('assets') / ITF Storage Centre ('storage')?
// Admins always can; for others it's switched on or off in Settings → Manage Users.
export function canUseModule(user, module) {
  if (!user) return false;
  // ITF Time Card ('timecard'): admins approve; contractors and ticked Users log time.
  if (module === 'timecard') return user.role === 'admin' || user.role === 'agent' || user.accessTimecard === true;
  if (user.role === 'admin' || user.role === 'agent') return true;
  // ITF Casuals: only when an admin has switched it on for them.
  if (user.role === 'contractor') return (module === 'assets' ? user.accessAssets : user.accessStorage) === true;
  return (module === 'assets' ? user.accessAssets : user.accessStorage) !== false;
}

export function useAuth() {
  return useContext(AuthContext);
}
