import { createContext, useContext, useEffect, useState } from "react";
import { apiFetch } from "./api";
const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    const unauthorized = () => { if (active) setUser(null); };
    window.addEventListener("depthwizard:unauthorized", unauthorized);
    apiFetch("/auth/me").then(response => response.json()).then(data => {
      if (active) setUser(data);
    }).catch(err => {
      if (active && err.status !== 401) setError(err.message);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; window.removeEventListener("depthwizard:unauthorized", unauthorized); };
  }, []);
  const authenticate = async (mode, values) => {
    const response = await apiFetch("/auth/" + mode, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
    });
    setUser(await response.json());
    setError(null);
  };
  const logout = async () => {
    await apiFetch("/auth/logout", { method: "POST" });
    setUser(null);
  };
  return <AuthContext.Provider value={{ user, loading, error, authenticate, logout }}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
