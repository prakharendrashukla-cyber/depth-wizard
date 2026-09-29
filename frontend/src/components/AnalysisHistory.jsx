import { useEffect, useState } from "react";
import { apiFetch } from "../api";
export default function AnalysisHistory({ onOpen, onClose }) {
  const [data, setData] = useState({ items: [], total: 0 });
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setBusy(true); setError("");
    try { setData(await (await apiFetch("/analyses?page=" + page + "&page_size=10")).json()); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); }, [page]);
  async function open(id) {
    setBusy(true); setError("");
    try { onOpen(await (await apiFetch("/analyses/" + id)).json()); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function remove(id) {
    setBusy(true); setError("");
    try {
      await apiFetch("/analyses/" + id, { method: "DELETE" });
      if (data.items.length === 1 && page > 1) setPage(page - 1);
      else await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <div className="modal-overlay" onClick={event => { if(event.target === event.currentTarget) onClose(); }}>
    <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="history-title">
      <div className="modal-header"><h2 id="history-title">My Analyses</h2><button className="modal-close" onClick={onClose} aria-label="Close history">✕</button></div>
      <div style={{ padding: 20 }}>
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">Loading…</p>}
        {!busy && !data.items.length && <p>No saved analyses yet. Upload an image to get started.</p>}
        <ul style={{ listStyle: "none", padding: 0 }}>
          {data.items.map(item => <li key={item.id} style={{ padding: "14px 0", borderBottom: "1px solid #30363d", overflowWrap: "anywhere" }}>
            <strong>{item.filename}</strong><p>{item.model_id} · {new Date(item.created_at).toLocaleString()}</p>
            <button className="header-btn" disabled={busy} onClick={() => open(item.id)}>Open</button>{" "}
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
