import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { cloudMode } from "../supabase/client";
import { listAnalyses, openAnalysis, deleteAnalysis, signedFile, loadProfile, saveProfile } from "../supabase/analyses";
import { useAuth } from "../AuthContext";
export default function AnalysisHistory({ onOpen, onClose }) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [data, setData] = useState({ items: [], total: 0 });
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setBusy(true); setError("");
    try { setData(cloudMode ? await listAnalyses(page) : await (await apiFetch("/analyses?page=" + page + "&page_size=10")).json()); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); }, [page]);
  useEffect(() => { if (cloudMode) loadProfile().then(profile => setName(profile.display_name)).catch(err => setError(err.message)); }, []);
  async function open(id) {
    setBusy(true); setError("");
    try { onOpen(cloudMode ? await openAnalysis(id) : await (await apiFetch("/analyses/" + id)).json()); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function remove(id) {
    setBusy(true); setError("");
    try {
      if (cloudMode) await deleteAnalysis(id);
      else await apiFetch("/analyses/" + id, { method: "DELETE" });
      if (data.items.length === 1 && page > 1) setPage(page - 1);
      else await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <div className="modal-overlay" onClick={event => { if(event.target === event.currentTarget) onClose(); }}>
    <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="history-title">
      <div className="modal-header"><h2 id="history-title">My Analyses</h2><button className="modal-close" onClick={onClose} aria-label="Close history">✕</button></div>
      <div style={{ padding: 20 }}>
        {cloudMode && <form onSubmit={async event => {
          event.preventDefault(); setBusy(true);
          try { await saveProfile(name, user.id); setProfileMessage("Display name updated."); }
          catch (err) { setError(err.message); }
          finally { setBusy(false); }
        }}><label>Display name <input value={name} onChange={e => setName(e.target.value)} maxLength={100} /></label>{" "}<button className="header-btn" disabled={busy}>Save name</button><p role="status">{profileMessage}</p></form>}
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">Loading…</p>}
        {!busy && !data.items.length && <p>No saved analyses yet. Upload an image to get started.</p>}
        <ul style={{ listStyle: "none", padding: 0 }}>
          {data.items.map(item => <li key={item.id} style={{ padding: "14px 0", borderBottom: "1px solid #30363d", overflowWrap: "anywhere" }}>
            <strong>{item.filename}</strong><p>{item.model_id} · {new Date(item.created_at).toLocaleString()}</p>
            {item.status && item.status !== "ready" && <p>Incomplete upload or deletion — use Delete to clean up.</p>}
            <button className="header-btn" disabled={busy || (cloudMode && item.status !== "ready")} onClick={() => open(item.id)}>Open</button>{" "}
            {item.ply_path && <button className="header-btn" disabled={busy} onClick={async () => {
              try { const a = document.createElement("a"); a.href = await signedFile(item.ply_path); a.download = "cloud.ply"; a.rel = "noreferrer"; a.click(); }
              catch (err) { setError(err.message); }
            }}>Download PLY</button>}{" "}
            <button className="header-btn" disabled={busy} onClick={() => remove(item.id)}>Delete</button>
          </li>)}
        </ul>
        <button className="header-btn" disabled={busy || page === 1} onClick={() => setPage(page - 1)}>Previous</button>{" "}
        <span>Page {page}</span>{" "}
        <button className="header-btn" disabled={busy || page * 10 >= data.total} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
