/*
 * AuthContext — the signed-in Supabase user for the standalone imaging app.
 * Same useAuth() shape the kyour viewer components expect ({ user, session }).
 */
import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

const AuthContext = createContext({ user: null, session: null, loading: true });

export function AuthProvider({ children }) {
  const [state, setState] = useState({ user: null, session: null, loading: true });

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setState({ user: data.session?.user ?? null, session: data.session ?? null, loading: false });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ user: session?.user ?? null, session: session ?? null, loading: false });
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
