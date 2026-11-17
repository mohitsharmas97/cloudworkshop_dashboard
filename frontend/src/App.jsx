import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowDownUp, CheckCircle2, CircleHelp, Cloud,
  Database, RefreshCw, Search, Server, ShieldAlert, Wifi, XCircle,
  RotateCcw, Clock3, Cpu
} from 'lucide-react'

const API = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')
const STATES = ['all', 'provisioning', 'ready', 'in_use', 'failed', 'deprovisioned']
const STATE_LABELS = {
  provisioning: 'Provisioning', ready: 'Ready', in_use: 'In use',
  failed: 'Failed', deprovisioned: 'Deprovisioned'
}
const money = value => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2
}).format(Number(value) || 0)

function App() {
  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState(null)
  const [risks, setRisks] = useState(null)
  const [stateFilter, setStateFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('state')
  const [order, setOrder] = useState('asc')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [riskError, setRiskError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState('')
  const [riskLoading, setRiskLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [lastRiskRefresh, setLastRiskRefresh] = useState(null)
  const searchTimer = useRef(null)

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true)
    else setRefreshing(true)
    setError('')
    try {
      const params = new URLSearchParams({
        state: stateFilter, search, sort_by: sort, order, page_size: '120'
      })
      const [envRes, sumRes] = await Promise.all([
        fetch(`${API}/api/environments?${params}`),
        fetch(`${API}/api/summary`)
      ])
      if (!envRes.ok) throw new Error(`Environment API failed (${envRes.status}).`)
      if (!sumRes.ok) throw new Error(`Summary API failed (${sumRes.status}).`)
      const [envData, sumData] = await Promise.all([envRes.json(), sumRes.json()])
      setRows(Array.isArray(envData.items) ? envData.items : [])
      setSummary(sumData)
      setLastUpdated(new Date())
    } catch (e) {
      setError(e.message || 'Unable to connect to the backend.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [stateFilter, search, sort, order])

  const loadRisks = useCallback(async (force = false) => {
    setRiskLoading(true)
    setRiskError('')
    try {
      const suffix = force ? '&refresh=true' : ''
      const response = await fetch(`${API}/api/at-risk/ai?stuck_minutes=20${suffix}`)
      if (!response.ok) throw new Error(`Risk analysis failed (${response.status}).`)
      const data = await response.json()
      setRisks(data)
      setLastRiskRefresh(new Date())
    } catch (e) {
      setRiskError(e.message || 'Risk analysis is unavailable.')
      setRisks({
        mode: 'unavailable', provider: 'unavailable',
        summary: 'Risk analysis could not be loaded. The environment table remains available.',
        items: [], ai_items: 0
      })
    } finally {
      setRiskLoading(false)
    }
  }, [])

  useEffect(() => { load(true) }, [load])
  useEffect(() => { loadRisks(false) }, [loadRisks])

  // Backend lifespan already simulates drift. The frontend only polls; it must not
  // POST another drift tick, otherwise the workshop advances twice as fast.
  useEffect(() => {
    const timer = setInterval(() => { load(false) }, 10000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => () => clearTimeout(searchTimer.current), [])

  const counts = summary?.state_counts || {}
  const total = Number(summary?.total_environments || 0)
  const riskItems = risks?.items || []
  const aiCount = Number(risks?.ai_items || riskItems.filter(x => x.source === 'ollama').length || 0)
  const ruleCount = Math.max(0, riskItems.length - aiCount)

  const distribution = useMemo(() => STATES.slice(1).map(state => ({
    state, count: Number(counts[state] || 0),
    width: total ? (Number(counts[state] || 0) / total) * 100 : 0
  })), [counts, total])

  async function reprovision(id) {
    setBusyId(id)
    setNotice('')
    try {
      const response = await fetch(`${API}/api/environments/${id}/reprovision`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || `Could not reprovision ${id}.`)
      setNotice(`${id} moved to provisioning. The environment list has been refreshed.`)
      await load(false)
      await loadRisks(true)
    } catch (e) {
      setNotice(e.message || 'Reprovision failed.')
    } finally {
      setBusyId('')
    }
  }

  async function resetDemo() {
    if (!window.confirm('Reset all 120 demo environments to their seeded starting state?')) return
    setNotice('')
    try {
      const response = await fetch(`${API}/api/demo/reset`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Could not reset demo data.')
      setStateFilter('all')
      setSearch('')
      setNotice(data.message || 'Demo data reset.')
      await load(true)
      await loadRisks(true)
    } catch (e) {
      setNotice(e.message || 'Demo reset failed.')
    }
  }

  function changeSort(field) {
    if (sort === field) setOrder(current => current === 'asc' ? 'desc' : 'asc')
    else { setSort(field); setOrder('asc') }
  }

  function updateSearch(value) {
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setSearch(value), 250)
  }

  const mode = risks?.mode
  const modeLabel = mode === 'ollama' ? 'OLLAMA · LOCAL AI'
    : mode === 'rules_fallback' ? 'RULE-BASED FALLBACK'
    : mode === 'rules' ? 'RULE-BASED'
    : mode === 'unavailable' ? 'UNAVAILABLE'
    : riskLoading ? 'ANALYZING' : 'NOT RUN'
  const modeClass = mode === 'ollama' ? 'mode-tag ai' : 'mode-tag'

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Cloud size={19}/></div>
        <div><strong>cloudlabs</strong><span>WORKSHOP OPS</span></div>
      </div>
      <div className="side-label">WORKSPACE</div>
      <div className="nav-item active"><Activity size={17}/> Operations overview</div>
      <div className="side-label side-label-spaced">SESSION</div>
      <div className="session-card"><span className="live-dot"/><div><b>Azure fundamentals</b><small>Live workshop · {summary?.total_environments ?? 120} seats</small></div></div>
      <div className="sidebar-bottom">
        <div className="side-label">SYSTEM STATUS</div>
        <div className="system-status"><span className="live-dot"/> API connected</div>
        <div className="system-status muted"><Database size={14}/> SQLite · seeded demo data</div>
        <div className="system-status muted"><Cpu size={14}/> AI: Ollama / rules</div>
      </div>
    </aside>

    <main className="main-content">
      <header className="topbar">
        <div>
          <div className="eyebrow">WORKSHOP / OPERATIONS</div>
          <h1>Environment overview</h1>
          <p>Monitor lab health, learner progress and session spend.</p>
        </div>
        <div className="top-actions">
          <span className="live-pill"><span className="live-dot"/> LIVE SESSION</span>
          <button className="refresh-btn" onClick={() => { load(false); loadRisks(false) }} disabled={refreshing || riskLoading}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''}/> Refresh
          </button>
        </div>
      </header>

      {error && <div className="error-banner" role="alert"><AlertTriangle size={17}/><span>{error}</span><button onClick={() => load(true)}>Retry</button></div>}
      {notice && <div className="notice-banner" role="status"><CheckCircle2 size={15}/><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss">×</button></div>}

      <section className="metric-strip" aria-label="Session summary">
        <Metric label="ACTIVE ENVIRONMENTS" value={summary ? summary.active_count : '—'} detail={`${counts.in_use || 0} currently in use`} icon={<Server size={17}/>} />
        <Metric label="FAILED ENVIRONMENTS" value={summary ? summary.failure_count : '—'} detail="Requires attention" icon={<XCircle size={17}/>} alert={Number(summary?.failure_count) > 0}/>
        <Metric label="ESTIMATED SESSION SPEND" value={summary ? money(summary.estimated_spend) : '—'} detail={`Burn rate ${money(summary?.burn_rate_per_hour)}/hr`} icon={<Database size={17}/>} />
        <Metric label="AVERAGE COMPLETION" value={summary ? `${summary.average_completion}%` : '—'} detail="Across all environments" icon={<CheckCircle2 size={17}/>} />
      </section>

      <section className="status-section">
        <div className="section-heading">
          <div><h2>Environment distribution</h2><p>Current state across the workshop</p></div>
          <span className="total-count">{total || '—'} ENVIRONMENTS</span>
        </div>
        <div className="state-bar" role="img" aria-label={distribution.map(x => `${STATE_LABELS[x.state]} ${x.count}`).join(', ')}>
          {distribution.map(({state, count, width}) => <div key={state} className={`state-segment ${state}`} style={{width: `${width}%`}} title={`${STATE_LABELS[state]}: ${count}`}/>)}
        </div>
        <div className="state-legend">
          {distribution.map(({state, count}) => <button key={state} onClick={() => setStateFilter(current => current === state ? 'all' : state)} className={`legend-item ${stateFilter === state ? 'selected' : ''}`} aria-pressed={stateFilter === state}>
            <i className={`legend-dot ${state}`}/><span>{STATE_LABELS[state]}</span><b>{count}</b>
          </button>)}
        </div>
      </section>

      <section className="risk-section">
        <div className="risk-header">
          <div className="risk-title">
            <div className="risk-icon"><ShieldAlert size={18}/></div>
            <div><h2>At-risk learners</h2><p>AI-assisted triage grounded in live environment data</p></div>
          </div>
          <div className="risk-meta">
            <span className={modeClass}>{modeLabel}</span>
            <button className="text-button" onClick={() => loadRisks(true)} disabled={riskLoading}>
              {riskLoading ? <><RefreshCw size={12} className="spin"/> Analyzing…</> : 'Re-run analysis'}
            </button>
          </div>
        </div>
        <p className="risk-summary">{risks?.summary || 'Checking failed environments and learners who have remained on a step for too long…'}</p>
        {risks && mode === 'ollama' && <div className="ai-breakdown">
          <span><Cpu size={13}/> {risks.model || 'Ollama'} reviewed <b>{aiCount}</b> learners</span>
          {ruleCount > 0 && <span><ShieldAlert size={13}/> Rules cover <b>{ruleCount}</b> additional learners</span>}
          {risks.cached && <span className="cache-label">Cached result</span>}
        </div>}
        {risks && mode === 'rules_fallback' && <div className="fallback-note"><CircleHelp size={13}/> Local model unavailable; deterministic rules are providing the recommendations.</div>}
        {riskError && <div className="risk-inline-error" role="alert">{riskError}</div>}
        {riskLoading && !risks ? <div className="risk-empty">Analyzing workshop signals…</div>
          : riskItems.length ? <div className="risk-list">
            {riskItems.map(item => <div className="risk-row" key={item.learner_id}>
              <span className={`risk-level ${item.risk_level}`}>{item.risk_level}</span>
              <b className="risk-learner">{item.learner_id}</b>
              <span className="risk-reason">{item.reason}</span>
              <span className="risk-action">{item.recommended_action}</span>
              <span className={`source-tag ${item.source === 'ollama' ? 'source-ai' : ''}`}>{item.source === 'ollama' ? 'OLLAMA' : 'RULES'}</span>
            </div>)}
          </div> : <div className="risk-empty"><CheckCircle2 size={16}/> No learners currently flagged for attention.</div>}
        <div className="risk-footnote"><CircleHelp size={13}/> AI suggestions are advisory. Deterministic rules remain available if the model is unavailable.</div>
      </section>

      <section className="table-section">
        <div className="table-heading">
          <div><h2>Lab environments</h2><p>Search, filter and act on individual learner environments.</p></div>
          <div className="table-tools">
            <label className="search-box"><Search size={15}/><input onChange={e => updateSearch(e.target.value)} placeholder="Search learner or lab" aria-label="Search learner or lab"/></label>
            <select value={stateFilter} onChange={e => setStateFilter(e.target.value)} aria-label="Filter by state">
              {STATES.map(s => <option key={s} value={s}>{s === 'all' ? 'All states' : STATE_LABELS[s]}</option>)}
            </select>
            <button className="reset-btn" onClick={resetDemo} title="Restore seeded demo data"><RotateCcw size={13}/> Reset demo</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th><button onClick={() => changeSort('learner_id')}>LEARNER <ArrowDownUp size={12}/></button></th>
              <th>ENVIRONMENT</th>
              <th><button onClick={() => changeSort('state')}>STATE <ArrowDownUp size={12}/></button></th>
              <th>STEP PROGRESS</th>
              <th><button onClick={() => changeSort('time_on_step_minutes')}>TIME IN STATE / STEP <ArrowDownUp size={12}/></button></th>
              <th><button onClick={() => changeSort('estimated_spend')}>SPEND <ArrowDownUp size={12}/></button></th>
              <th>FAILURE / ACTION</th>
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan="7" className="table-message"><RefreshCw size={16} className="spin"/> Loading environment data…</td></tr>
                : error ? <tr><td colSpan="7" className="table-message">Unable to load rows. Check that the API is running.</td></tr>
                : rows.length === 0 ? <tr><td colSpan="7" className="table-message">No environments match this filter. Try another state or search term.</td></tr>
                : rows.map(row => <tr key={row.learner_id} className={row.state === 'failed' ? 'failed-row' : ''}>
                  <td><b>{row.learner_id}</b><small>{row.learner_name}</small></td>
                  <td className="env-name">{row.environment_name}</td>
                  <td><span className={`state-badge ${row.state}`}><i/> {STATE_LABELS[row.state] || row.state}</span></td>
                  <td><div className="progress-cell"><div className="progress-track"><span style={{width: `${row.progress_percent}%`}}/></div><small>{row.progress_percent}% · {row.step_name || `Step ${row.current_step}`} ({row.current_step}/{row.total_steps})</small></div></td>
                  <td className={row.time_on_step_minutes >= 20 ? 'time-alert' : 'tabular'}>{row.time_on_step_minutes} min</td>
                  <td className="tabular">{money(row.estimated_spend)}</td>
                  <td className="action-cell">{row.state === 'failed' ? <><span className="failure-reason">{row.failure_reason || 'Failure reason not recorded'}</span><button className="action-btn" disabled={busyId === row.learner_id} onClick={() => reprovision(row.learner_id)}>{busyId === row.learner_id ? 'Working…' : 'Reprovision'}</button></> : <span className="no-action">—</span>}</td>
                </tr>)}
            </tbody>
          </table>
        </div>
        <div className="table-footer">
          <span>Showing <b>{rows.length}</b> of <b>{total}</b> environments</span>
          <span><Wifi size={13}/> Polling every 10 seconds · Last update {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'}</span>
        </div>
      </section>
      <footer className="footer-note">CLOUDLABS WORKSHOP OPERATIONS <span>·</span> SIMULATED AZURE ENVIRONMENTS <span>·</span> DEMO DATA</footer>
    </main>
  </div>
}

function Metric({ label, value, detail, icon, alert }) {
  return <article className={`metric ${alert ? 'metric-alert' : ''}`}>
    <div className="metric-top"><span>{label}</span><i>{icon}</i></div>
    <strong>{value}</strong><small>{detail}</small>
  </article>
}

export default App
