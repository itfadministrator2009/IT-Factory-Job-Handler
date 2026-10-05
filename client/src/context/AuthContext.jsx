import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import api from '../api';
import { resetPresence } from '../components/WhoIsOnline';

const AuthContext = createContext(null);

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

  const login = useCallback(async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password });
    localStorage.setItem('helpdesk_token', data.token);
    localStorage.setItem('helpdesk_user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }, []);

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
    <AuthContext.Provider value={{ user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// Can this user open the ITF Asset Tracker ('assets') / ITF Storage Centre ('storage')?
// Admins always can; for others it's switched on or off in Settings → Manage Users.
export function canUseModule(user, module) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'agent') return true;
  return (module === 'assets' ? user.accessAssets : user.accessStorage) !== false;
}

export function useAuth() {
  return useContext(AuthContext);
}
