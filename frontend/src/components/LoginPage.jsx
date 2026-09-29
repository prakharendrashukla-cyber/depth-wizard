import { useState } from "react";
import { useAuth } from "../AuthContext";
import "./LoginPage.css";

export default function LoginPage() {
  const { authenticate, error: connectionError } = useAuth();
  const [mode, setMode] = useState("login");
  const [values, setValues] = useState({ email: "", password: "", name: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const register = mode === "register";
  async function submit(event) {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) return setError("Enter a valid email address.");
    if (values.password.length < 8) return setError("Use at least 8 characters for your password.");
    if (register && !values.name.trim()) return setError("Enter your name.");
    setBusy(true); setError("");
    try { await authenticate(mode, values); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  function field(event) { setValues(previous => ({ ...previous, [event.target.name]: event.target.value })); }
  return (
    <main className="login-screen">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">🧙‍♂️ Depth Wizard</div>
        <p className="login-intro">Single-view height estimation and 3D exploration</p>
        <h1 id="login-title">{register ? "Create your account" : "Welcome back"}</h1>
        <p className="login-help">Save your analyses and return to them whenever you need.</p>
        <form onSubmit={submit}>
          {register && <label>Name<input name="name" autoComplete="name" value={values.name} onChange={field} maxLength={100} required disabled={busy} /></label>}
          <label>Email<input name="email" type="email" autoComplete="email" value={values.email} onChange={field} maxLength={254} required disabled={busy} /></label>
          <label>Password<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} value={values.password} onChange={field} minLength={8} maxLength={1024} required disabled={busy} /></label>
          {register && <small>At least 8 characters</small>}
          {(error || connectionError) && <p className="login-error" role="alert">{error || connectionError}</p>}
          <button className="login-submit" type="submit" disabled={busy}>{busy ? "Please wait…" : register ? "Create account" : "Log in"}</button>
        </form>
        <button className="login-toggle" disabled={busy} onClick={() => { setMode(register ? "login" : "register"); setError(""); }}>
          {register ? "Already have an account? Log in" : "New here? Create an account"}
        </button>
      </section>
    </main>
  );
}
