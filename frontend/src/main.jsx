import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { AuthProvider, useAuth } from "./AuthContext";
import LoginPage from "./components/LoginPage";
import "./index.css";

function AuthenticatedApp() {
  const { user, loading, guest, recovering } = useAuth();
  if (loading) return <p role="status">Loading...</p>;
  return !recovering && (user || guest) ? <App key={user?.id || "guest"} /> : <LoginPage />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider><AuthenticatedApp /></AuthProvider>
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(console.error);
    });
  } else {
    navigator.serviceWorker.getRegistrations().then(registrations =>
      registrations.forEach(registration => registration.unregister()));
  }
}
