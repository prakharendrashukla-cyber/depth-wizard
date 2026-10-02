import { useState } from "react";
import { useAuth } from "../AuthContext";
import { publicDemoOnly } from "../runtimeConfig.js";
import "./LoginPage.css";

export default function LoginPage() {
  const { authenticate, error: connectionError, cloud, enterGuest, resetPassword, recovering, updatePassword, googleEnabled, googleLogin } = useAuth();
  const [mode, setMode] = useState("login");
  const [values, setValues] = useState({ email: "", password: "", name: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const register = mode === "register";
  async function submit(event) {
    event.preventDefault();
    if (!recovering && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) return setError("Enter a valid email address.");
    if ((register || recovering) && values.password.length < 8) return setError("Use at least 8 characters for your password.");
    if (mode === "login" && !recovering && !values.password) return setError("Enter your password.");
    if (register && !cloud && !values.name.trim()) return setError("Enter your name.");
    setBusy(true); setError(""); setMessage("");
    try { setMessage(recovering ? await updatePassword(values.password) : mode === "reset" ? await resetPassword(values.email) : await authenticate(mode, values)); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  function field(event) { setValues(previous => ({ ...previous, [event.target.name]: event.target.value })); }
  return (
    <main className="login-screen">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">🧙‍♂️ Depth Wizard</div>
        <p className="login-intro">Single-view height estimation and 3D exploration</p>
        <h1 id="login-title">{recovering ? "Choose a new password" : mode === "reset" ? "Reset password" : register ? "Create your account" : "Welcome back"}</h1>
        <p className="login-help">{publicDemoOnly ? "Sign in to access your own saved history. This website offers an offline demo." : "Save your analyses and return to them whenever you need."}</p>
        <form onSubmit={submit}>
          {register && !cloud && <label>Name<input name="name" autoComplete="name" value={values.name} onChange={field} maxLength={100} required disabled={busy} /></label>}
          {!recovering && <label>Email<input name="email" type="email" autoComplete="email" value={values.email} onChange={field} maxLength={254} required disabled={busy} /></label>}
          {(mode !== "reset" || recovering) && <label>Password<input name="password" type="password" autoComplete={register || recovering ? "new-password" : "current-password"} value={values.password} onChange={field} minLength={register || recovering ? 8 : 1} maxLength={1024} required disabled={busy} /></label>}
          {register && <small>At least 8 characters</small>}
          {(error || connectionError) && <p className="login-error" role="alert">{error || connectionError}</p>}
          {message && <p role="status">{message}</p>}
          <button className="login-submit" type="submit" disabled={busy}>{busy ? "Please wait…" : recovering ? "Save password" : mode === "reset" ? "Send reset link" : register ? "Create account" : "Log in"}</button>
        </form>
        {!recovering && <button className="login-toggle" disabled={busy} onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); setMessage(""); }}>
          {mode === "login" ? "New here? Create an account" : "Back to log in"}
        </button>}
        {cloud && !recovering && <>
          {googleEnabled && <button className="login-toggle" disabled={busy} onClick={() => googleLogin().catch(err => setError(err.message))}>Sign in with Google</button>}
          <button className="login-submit" type="button" disabled={busy} onClick={enterGuest}>Try without login</button>
          <p className="login-help">{publicDemoOnly ? "Explore the offline demo without an account. Cloud image analysis is disabled." : "Guest mode includes all analysis tools. Sign in to save history."}</p>
        </>}
      </section>
    </main>
  );
}
