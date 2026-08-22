import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Spinner } from '../components/ui.jsx';

/** Suggestions are role-aware, so the copilot opens on something useful. */
const SUGGESTIONS = {
  caller: ['Who should I call today?', 'Which callbacks are due?', 'Any leads that have gone cold?'],
  dealer: ['Which warm cards need moving?', 'What follow-ups are due today?'],
  sales_rm: ['Who should I call today?', 'Which KYC journeys are stuck?', 'Which leads are at risk of going cold?'],
  sales_supervisor: ['Which RMs have overdue follow-ups?', 'How big is the team pipeline?', 'Any SLA breaches on my team\'s leads?'],
  partner_rm: ['How are my partners performing?', 'Which partners have stalled onboarding?'],
  product_rm: ['Which KYC journeys are stuck?', 'How many warm cards am I watching?'],
  product_supervisor: ['Which KYC journeys are stalled?', 'What is the average completion time?'],
  customer_care: ['Any SLA breaches?', 'What is in my queue right now?', 'Which tickets are waiting on the client?'],
  marketing_manager: ['Which lead source is performing best?', 'How did the last campaign do?'],
  admin: ['How big is the pipeline?', 'Any SLA breaches?', 'Which KYC journeys are stuck?'],
  superadmin: ['How big is the pipeline?', 'Any SLA breaches?', 'Which KYC journeys are stuck?'],
};

export default function Copilot({ open, onClose, session }) {
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState(null);
  const logRef = useRef(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  async function ask(text) {
    const q = (text ?? question).trim();
    if (!q || busy) return;

    setQuestion('');
    setMessages((m) => [...m, { role: 'user', content: q }]);
    setBusy(true);
    try {
      const res = await api.post('/ai/copilot', { question: q, history: messages.slice(-8) });
      setMessages((m) => [...m, { role: 'assistant', content: res.reply }]);
      setMeta(res);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', content: `Couldn't answer that: ${err.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  const suggestions = SUGGESTIONS[session.role] || SUGGESTIONS.admin;

  return (
    <aside className="copilot">
      <div className="card-head">
        <div>
          <h2>Copilot</h2>
          <div className="tiny muted">
            Answers only from what your role can see
            {meta && ` · ${meta.grounded_in.leads} leads, ${meta.grounded_in.tickets} tickets`}
          </div>
        </div>
        <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>

      <div className="copilot-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>Ask about your book of work.</p>
            {suggestions.map((s) => <button key={s} className="suggestion" onClick={() => ask(s)}>{s}</button>)}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble bubble-${m.role === 'user' ? 'user' : 'ai'}`}>{m.content}</div>
        ))}
        {busy && <div className="bubble bubble-ai row"><Spinner /> <span className="muted">Reading your pipeline…</span></div>}
      </div>

      <form className="row" style={{ padding: '10px 14px 14px', borderTop: '1px solid var(--border)' }} onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question…" autoFocus />
        <button className="btn-primary" disabled={busy || !question.trim()}>Send</button>
      </form>
    </aside>
  );
}
