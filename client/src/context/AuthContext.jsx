import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import api from '../api';
import IdleLogout from '../components/IdleLogout';
import { resetPresence } from '../components/WhoIsOnline';
import {
  getToken, getStoredUser, saveSession, saveUser, clearSession, broadcastLogout, onLogoutElsewhere, setLogoutReason,
} from '../session';

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
  const [user, setUser] = useState(() => (getToken() ? getStoredUser() : null));

  // Pick up role / section-access changes made in Settings without signing out.
  useEffect(() => {
    if (!getToken()) return;
    api.get('/auth/me').then(({ data }) => {
      if (!data?.user) return;
      saveUser(data.user);
      setUser(data.user);
    }).catch(() => {});
  }, []);

  const finishLogin = useCallback((data) => {
    saveSession(data.token, data.user);
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
    saveSession(data.token, data.user);
    setUser(data.user);
    return data.user;
  }, []);

  // reason 'idle': 30 minutes with no activity. Logging out in one tab logs
  // out every open Work Desk tab.
  const logout = useCallback((reason, fromOtherTab) => {
    // Drop off the "online now" list straight away (the token is read now,
    // before it's removed below).
    const token = getToken();
    if (token && !fromOtherTab) api.delete('/presence', { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    resetPresence();
    clearSession();
    if (reason === 'idle') setLogoutReason('idle');
    if (!fromOtherTab) broadcastLogout(reason);
    setUser(null);
  }, []);
  const logoutIdle = useCallback(() => logout('idle'), [logout]);
  useEffect(() => onLogoutElsewhere((reason) => logout(reason === 'idle' ? 'idle' : undefined, true)), [logout]);

  return (
    <AuthContext.Provider value={{ user, login, verifyCode, register, logout }}>
      {children}
      {user && <IdleLogout onIdle={logoutIdle} />}
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
