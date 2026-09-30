import { useEffect, useState } from "react";
import { supabase, requireSupabase, authRedirect } from "./client";
import { authenticateWithEmail, authErrorMessage } from "./authActions";

export default function CloudAuthProvider({ context: Context, children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [error, setError] = useState(null);
  const [guest, setGuest] = useState(() => sessionStorage.getItem("depthwizard-guest") === "yes");
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const apply = (session) => { if (active) { setUser(session?.user || null); setLoading(false); } };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // Keep this callback synchronous; SDK calls inside it can deadlock.
      apply(session);
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });
    supabase.auth.getSession().then(({ data, error: err }) => {
      if (!active) return;
      if (err) setError(err.message);
      apply(data.session);
      if (data.session && new URL(location.href).searchParams.has("reset")) setRecovering(true);
    }).catch(err => { if (active) { setError(err.message); setLoading(false); } });
    const expired = () => {
      setUser(null); setGuest(false); sessionStorage.removeItem("depthwizard-guest");
      setError("Your session expired. Please log in again.");
      // Outside the Auth callback: clear a rejected token before entering guest mode.
      supabase.auth.signOut({ scope: "local" }).catch(() => {});
    };
    window.addEventListener("depthwizard:unauthorized", expired);
    return () => { active = false; subscription.unsubscribe(); window.removeEventListener("depthwizard:unauthorized", expired); };
  }, []);
  async function authenticate(mode, values) {
    const data = await authenticateWithEmail(requireSupabase().auth, mode, values, authRedirect());
    setError(null);
    if (data.session) {
      setUser(data.session.user); setGuest(false); sessionStorage.removeItem("depthwizard-guest");
    }
    return data.session ? "" : "Check your email to confirm your account, then log in.";
  }
  async function logout() {
    const { error } = await requireSupabase().auth.signOut();
    if (error) throw new Error(authErrorMessage(error));
    setUser(null); setGuest(false); sessionStorage.removeItem("depthwizard-guest");
  }
  async function resetPassword(email) {
    const redirect = new URL(authRedirect()); redirect.searchParams.set("reset", "1");
    const { error } = await requireSupabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: redirect.href });
    if (error) throw new Error(authErrorMessage(error));
    return "If this account exists, a reset link will arrive. Open it in this browser.";
  }
  async function updatePassword(password) {
    const { error } = await requireSupabase().auth.updateUser({ password });
    if (error) throw error;
    setRecovering(false); history.replaceState({}, "", location.pathname);
  }
  async function googleLogin() {
    const { error } = await requireSupabase().auth.signInWithOAuth({ provider: "google", options: { redirectTo: authRedirect() } });
    if (error) throw error;
  }
  const enterGuest = () => { sessionStorage.setItem("depthwizard-guest", "yes"); setGuest(true); };
  const leaveGuest = () => { sessionStorage.removeItem("depthwizard-guest"); setGuest(false); };
  return <Context.Provider value={{ user, loading, error, guest, recovering, authenticate, logout,
    resetPassword, updatePassword, enterGuest, leaveGuest, googleLogin,
    googleEnabled: import.meta.env.VITE_SUPABASE_GOOGLE === "true", cloud: true }}>{children}</Context.Provider>;
}
