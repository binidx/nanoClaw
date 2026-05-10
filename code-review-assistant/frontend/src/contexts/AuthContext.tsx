import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type UserRole = "admin" | "viewer";

interface AuthState {
  authenticated: boolean;
  role: UserRole;
}

interface AuthContextValue extends AuthState {
  setAuth: (role: UserRole, apiKey: string) => void;
  logout: () => void;
  isAdmin: boolean;
}

const AUTH_KEY = "code_review_auth";
const API_KEY_KEY = "code_review_api_key";

function loadAuth(): AuthState {
  // Migrate legacy session storage state to local storage.
  const legacy = sessionStorage.getItem(AUTH_KEY);
  if (legacy && !localStorage.getItem(AUTH_KEY)) {
    localStorage.setItem(AUTH_KEY, legacy);
    sessionStorage.removeItem(AUTH_KEY);
  }
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.authenticated) return parsed;
    }
  } catch { /* ignore */ }
  return { authenticated: false, role: "viewer" };
}

function saveAuth(state: AuthState) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(state));
}

export function getStoredApiKey(): string {
  const legacy = sessionStorage.getItem(API_KEY_KEY);
  if (legacy && !localStorage.getItem(API_KEY_KEY)) {
    localStorage.setItem(API_KEY_KEY, legacy);
    sessionStorage.removeItem(API_KEY_KEY);
  }
  return localStorage.getItem(API_KEY_KEY) || "";
}

const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  role: "viewer",
  isAdmin: false,
  setAuth: () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(loadAuth);

  const setAuth = useCallback((role: UserRole, apiKey: string) => {
    const next: AuthState = { authenticated: true, role };
    setState(next);
    saveAuth(next);
    localStorage.setItem(API_KEY_KEY, apiKey);
  }, []);

  const logout = useCallback(() => {
    const next: AuthState = { authenticated: false, role: "viewer" };
    setState(next);
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(API_KEY_KEY);
    // Cleanup legacy keys if they still exist.
    sessionStorage.removeItem(AUTH_KEY);
    sessionStorage.removeItem(API_KEY_KEY);
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, isAdmin: state.role === "admin", setAuth, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
