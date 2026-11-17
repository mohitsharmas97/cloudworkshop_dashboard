import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowUp, ArrowDown, ArrowUpDown, CheckCircle2,
  CircleHelp, Clock3, Cloud, Database, RefreshCw, Search, Server,
  ShieldAlert, Wifi, XCircle, RotateCcw, Cpu
} from 'lucide-react'

const API = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')
const STATES = ['all', 'provisioning', 'ready', 'in_use', 'failed', 'deprovisioned']
const STATE_LABELS = {
  provisioning: 'Provisioning', ready: 'Ready', in_use: 'In use',
  failed: 'Failed', deprovisioned: 'Deprovisioned'
}
const STEP_NAMES = ['Create resource group', 'Deploy VNet', 'Provision VM', 'Config storage', 'Deploy & verify']
const money = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(v) || 0)

function SortIcon({ field, sort, order }) {
  if (sort !== field) return <ArrowUpDown size={11} className="sort-inactive" />
  return order === 'asc' ? <ArrowUp size={11} className="sort-active" /> : <ArrowDown size={11} className="sort-active" />
}

function App() {
  const [rows, setRows]               = useState([])
  const [summary, setSummary]         = useState(null)
  const [risks, setRisks]             = useState(null)
  const [stateFilter, setStateFilter] = useState('all')
  const [search, setSearch]           = useState('')
  const [sort, setSort]               = useState('state')
  const [order, setOrder]             = useState('asc')
  const [stuckOnly, setStuckOnly]     = useState(false)
  const [loading, setLoading]         = useState(true)
  const [refreshing, setRefreshing]   = useState(false)
  const [error, setError]             = useState('')
  const [riskError, setRiskError]     = useState('')
  const [notice, setNotice]           = useState('')
  const [busyId, setBusyId]           = useState('')
  const [riskLoading, setRiskLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const searchTimer = useRef(null)

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true); else setRefreshing(true)
    setError('')
    try {
      const params = new URLSearchParams({ sort_by: sort, order, page_size: '120' })
      if (stuckOnly) { params.set('state', 'in_use'); params.set('min_stuck_minutes', '20') }
      else params.set('state', stateFilter)
      if (search) params.set('search', search)
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
    } catch (e) { setError(e.message || 'Unable to connect to the backend.') }
    finally { setLoading(false); setRefreshing(false) }
  }, [stateFilter, search, sort, order, stuckOnly])

  const loadRisks = useCallback(async (force = false) => {
    setRiskLoading(true); setRiskError('')
    try {
      const res = await fetch(`${API}/api/at-risk/ai?stuck_minutes=20${force ? '&refresh=true' : ''}`)
      if (!res.ok) throw new Error(`Risk analysis failed (${res.status}).`)
      setRisks(await res.json())
    } catch (e) {
      setRiskError(e.message || 'Risk analysis is unavailable.')
      setRisks({ mode: 'unavailable', provider: 'unavailable',
        summary: 'Risk analysis could not be loaded. The environment table remains available.',
        items: [], ai_items: 0 })
    } finally { setRiskLoading(false) }
  }, [])

  useEffect(() => { load(true) }, [load])
  useEffect(() => { loadRisks(false) }, [loadRisks])
  useEffect(() => {
    const t = setInterval(() => load(false), 10000)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => () => clearTimeout(searchTimer.current), [])

  const counts      = summary?.state_counts || {}
  const total       = Number(summary?.total_environments || 0)
  const activeCount = Number(summary?.active_count || 0)
  const stuckCount  = Number(summary?.stuck_count || 0)
  const avgDone     = Number(summary?.average_completion || 0)
  const riskItems   = risks?.items || []
  const aiCount     = Number(risks?.ai_items || riskItems.filter(x => x.source === 'ollama').length || 0)
  const ruleCount   = Math.max(0, riskItems.length - aiCount)

  const distribution = useMemo(() =>
    STATES.slice(1).map(state => ({
      state, count: Number(counts[state] || 0),
      width: total ? (Number(counts[state] || 0) / total) * 100 : 0
    })), [counts, total])

  const stepBreakdown = useMemo(() => {
    const byStep = summary?.in_use_by_step || {}
    return Array.from({ length: 5 }, (_, i) => ({
      step: i + 1, name: STEP_NAMES[i],
      count: Number(byStep[String(i + 1)] || 0)
    }))
  }, [summary])
  const maxStep = Math.max(1, ...stepBreakdown.map(s => s.count))

  async function reprovision(id) {
    setBusyId(id); setNotice('')
    try {
      const res = await fetch(`${API}/api/environments/${id}/reprovision`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `Could not reprovision ${id}.`)
      setNotice(`${id} moved to provisioning. The environment list has been refreshed.`)
      await load(false); await loadRisks(true)
    } catch (e) { setNotice(e.message || 'Reprovision failed.') }
    finally { setBusyId('') }
  }

  async function resetDemo() {
    if (!window.confirm('Reset all 120 demo environments to their seeded starting state?')) return
    setNotice('')
    try {
      const res = await fetch(`${API}/api/demo/reset`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not reset demo data.')
      setStateFilter('all'); setSearch(''); setStuckOnly(false)
      setNotice(data.message || 'Demo data reset.')
      await load(true); await loadRisks(true)
    } catch (e) { setNotice(e.message || 'Demo reset failed.') }
  }

  function changeSort(field) {
    if (sort === field) setOrder(o => o === 'asc' ? 'desc' : 'asc')
    else { setSort(field); setOrder('asc') }
  }

  function updateSearch(value) {
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setSearch(value), 250)
  }

  function timeClass(min) {
    if (min >= 40) return 'time-critical'
    if (min >= 20) return 'time-warn'
    return 'tabular'
  }

  const mode      = risks?.mode
  const modeLabel = mode === 'ollama' ? 'OLLAMA · LOCAL AI'
    : mode === 'rules_fallback' ? 'RULE-BASED FALLBACK'
    : mode === 'rules' ? 'RULE-BASED'
    : mode === 'unavailable' ? 'UNAVAILABLE'
    : riskLoading ? 'ANALYZING' : 'NOT RUN'
  const modeClass = mode === 'ollama' ? 'mode-tag ai' : 'mode-tag'

  return <div className="app-shell">
    {/* ── Sidebar ───────────────────────────────────────── */}
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Cloud size={19}/></div>
        <div><strong>cloudlabs</strong><span>WORKSHOP OPS</span></div>
      </div>

      <div className="side-label">WORKSPACE</div>
      <div className="nav-item active"><Activity size={17}/> Operations overview</div>

      <div className="side-label side-label-spaced">SESSION</div>
      <div className="session-card">
        <span className="live-dot"/>
        <div><b>Azure fundamentals</b><small>Live workshop · {summary?.total_environments ?? 120} seats</small></div>
      </div>

      {/* Quick-glance stats */}
      <div className="sidebar-stats">
        <div className="sidebar-stat">
          <span className="stat-val">{activeCount || '—'}</span>
          <span className="stat-lbl">ACTIVE</span>
        </div>
        <div className="sidebar-stat">
          <span className="stat-val stat-red">{counts.failed ?? '—'}</span>
          <span className="stat-lbl">FAILED</span>
        </div>
        <div className="sidebar-stat">
          <span className={`stat-val${stuckCount > 0 ? ' stat-orange' : ''}`}>{stuckCount || '—'}</span>
          <span className="stat-lbl">STUCK</span>
        </div>
      </div>

      <div className="sidebar-bottom">
        <div className="side-label">SYSTEM STATUS</div>
        <div className="system-status"><span className="live-dot"/> API connected</div>
        <div className="system-status muted"><Database size={14}/> SQLite · seeded demo data</div>
        <div className="system-status muted"><Cpu size={14}/> AI: Ollama / rules</div>
      </div>
    </aside>

    {/* ── Main ──────────────────────────────────────────── */}
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

      {error  && <div className="error-banner"  role="alert"><AlertTriangle size={17}/><span>{error}</span><button onClick={() => load(true)}>Retry</button></div>}
      {notice && <div className="notice-banner" role="status"><CheckCircle2 size={15}/><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss">×</button></div>}

      {/* ── Metric strip ──────────────────────────────── */}
      <section className="metric-strip" aria-label="Session summary">
        <Metric label="ACTIVE ENVIRONMENTS"
          value={!summary ? '—' : activeCount > 0 ? `${activeCount} / ${total}` : activeCount}
          detail={activeCount > 0
            ? `${counts.in_use || 0} in use · ${counts.provisioning || 0} provisioning`
            : `${counts.deprovisioned || 0} deprovisioned · ${counts.failed || 0} failed`}
          icon={<Server size={17}/>} />
        <Metric label="FAILED ENVIRONMENTS"
          value={summary ? summary.failure_count : '—'}
          detail="Requires immediate attention"
          icon={<XCircle size={17}/>}
          alert={Number(summary?.failure_count) > 0} />
        <Metric label="STUCK > 20 MIN"
          value={summary ? stuckCount : '—'}
          detail={activeCount > 0
            ? `Avg ${avgDone}% completion across all envs`
            : `No active envs · avg ${avgDone}% completion`}
          icon={<Clock3 size={17}/>}
          warn={stuckCount > 0} />
        <Metric label="SESSION SPEND"
          value={summary ? money(summary.estimated_spend) : '—'}
          detail={`Burn rate ${money(summary?.burn_rate_per_hour)}/hr`}
          icon={<Database size={17}/>} />
      </section>

      {/* ── State distribution ────────────────────────── */}
      <section className="status-section">
        <div className="section-heading">
          <div><h2>Environment distribution</h2><p>Current state across the workshop</p></div>
          <span className="total-count">{total || '—'} ENVIRONMENTS</span>
        </div>

        <div className="state-bar" role="img" aria-label={distribution.map(x => `${STATE_LABELS[x.state]} ${x.count}`).join(', ')}>
          {distribution.map(({ state, count, width }) =>
            <div key={state} className={`state-segment ${state}`} style={{ width: `${width}%` }}
              title={`${STATE_LABELS[state]}: ${count}`}/>)}
        </div>

        <div className="state-legend">
          {distribution.map(({ state, count }) =>
            <button key={state}
              onClick={() => setStateFilter(c => c === state ? 'all' : state)}
              className={`legend-item ${stateFilter === state ? 'selected' : ''}`}
              aria-pressed={stateFilter === state}>
              <i className={`legend-dot ${state}`}/><span>{STATE_LABELS[state]}</span><b>{count}</b>
            </button>)}
        </div>

        {/* Step cohort mini-chart */}
        {stepBreakdown.some(s => s.count > 0) && (
          <div className="step-breakdown">
            <div className="step-breakdown-label">IN-USE COHORT BY STEP</div>
            <div className="step-bars">
              {stepBreakdown.map(({ step, name, count }) => (
                <div key={step} className="step-bar-item" title={`Step ${step}: ${name} — ${count} learner${count !== 1 ? 's' : ''}`}>
                  <span className="step-bar-count">{count || ''}</span>
                  <div className="step-bar-track">
                    <div className="step-bar-fill" style={{ height: `${(count / maxStep) * 100}%` }}/>
                  </div>
                  <span className="step-bar-label">S{step}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── At-risk panel ─────────────────────────────── */}
      <section className="risk-section">
        <div className="risk-header">
          <div className="risk-title">
            <div className="risk-icon"><ShieldAlert size={18}/></div>
            <div><h2>At-risk learners</h2><p>AI-assisted triage grounded in live environment data</p></div>
          </div>
          <div className="risk-meta">
            {riskItems.length > 0 && <span className="risk-count-badge">{riskItems.length} flagged</span>}
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
        {risks && mode === 'rules_fallback' && <div className="fallback-note"><CircleHelp size={13}/> Local model unavailable; deterministic rules are providing recommendations.</div>}
        {riskError && <div className="risk-inline-error" role="alert">{riskError}</div>}

        {riskLoading && !risks
          ? <div className="risk-empty">Analyzing workshop signals…</div>
          : riskItems.length
            ? <div className="risk-list" role="list">
                {riskItems.map(item => (
                  <div className="risk-row" key={item.learner_id} role="listitem">
                    <span className={`risk-level ${item.risk_level}`}>{item.risk_level}</span>
                    <div className="risk-learner-cell">
                      <b className="risk-learner">{item.learner_id}</b>
                      {item.evidence?.reprovision_count > 0 &&
                        <span className="retries-badge" title={`Reprovisioned ${item.evidence.reprovision_count} time(s)`}>
                          ↺ {item.evidence.reprovision_count}x
                        </span>}
                    </div>
                    <span className="risk-reason">{item.reason}</span>
                    <span className="risk-action">{item.recommended_action}</span>
                    <span className={`source-tag ${item.source === 'ollama' ? 'source-ai' : ''}`}>
                      {item.source === 'ollama' ? 'OLLAMA' : 'RULES'}
                    </span>
                  </div>
                ))}
              </div>
            : <div className="risk-empty"><CheckCircle2 size={16}/> No learners currently flagged for attention.</div>}

        <div className="risk-footnote"><CircleHelp size={13}/> AI suggestions are advisory. Deterministic rules remain available if the model is unavailable.</div>
      </section>

      {/* ── Environment table ─────────────────────────── */}
      <section className="table-section">
        <div className="table-heading">
          <div><h2>Lab environments</h2><p>Search, filter and act on individual learner environments.</p></div>
          <div className="table-tools">
            <label className="search-box">
              <Search size={15}/>
              <input onChange={e => updateSearch(e.target.value)} placeholder="Search learner or lab" aria-label="Search learner or lab"/>
            </label>
            <select
              value={stateFilter}
              onChange={e => { setStateFilter(e.target.value); setStuckOnly(false) }}
              aria-label="Filter by state"
              disabled={stuckOnly}>
              {STATES.map(s => <option key={s} value={s}>{s === 'all' ? 'All states' : STATE_LABELS[s]}</option>)}
            </select>
            <button
              className={`stuck-btn${stuckOnly ? ' active' : ''}`}
              onClick={() => { setStuckOnly(v => !v); setStateFilter('all') }}
              aria-pressed={stuckOnly}
              title="Show only in-use learners stuck for 20+ minutes">
              <Clock3 size={13}/> Stuck
              {stuckCount > 0 && <span className="stuck-pill">{stuckCount}</span>}
            </button>
            <button className="reset-btn" onClick={resetDemo} title="Restore seeded demo data">
              <RotateCcw size={13}/> Reset demo
            </button>
          </div>
        </div>

        {/* Screen-reader live region for auto-refresh */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {lastUpdated ? `Environment table updated at ${lastUpdated.toLocaleTimeString()}, showing ${rows.length} of ${total} environments.` : ''}
        </div>

        <div className="table-wrap">
          <table aria-label="Lab environments" aria-rowcount={total}>
            <thead><tr>
              <th className={sort === 'learner_id' ? 'col-sorted' : ''}>
                <button onClick={() => changeSort('learner_id')}>LEARNER <SortIcon field="learner_id" sort={sort} order={order}/></button>
              </th>
              <th>ENVIRONMENT</th>
              <th className={sort === 'state' ? 'col-sorted' : ''}>
                <button onClick={() => changeSort('state')}>STATE <SortIcon field="state" sort={sort} order={order}/></button>
              </th>
              <th className={sort === 'progress_percent' ? 'col-sorted' : ''}>
                <button onClick={() => changeSort('progress_percent')}>STEP PROGRESS <SortIcon field="progress_percent" sort={sort} order={order}/></button>
              </th>
              <th className={sort === 'time_on_step_minutes' ? 'col-sorted' : ''}>
                <button onClick={() => changeSort('time_on_step_minutes')}>TIME IN STEP <SortIcon field="time_on_step_minutes" sort={sort} order={order}/></button>
              </th>
              <th className={sort === 'estimated_spend' ? 'col-sorted' : ''}>
                <button onClick={() => changeSort('estimated_spend')}>SPEND <SortIcon field="estimated_spend" sort={sort} order={order}/></button>
              </th>
              <th>FAILURE / ACTION</th>
            </tr></thead>
            <tbody>
              {loading
                ? <tr><td colSpan="7" className="table-message"><RefreshCw size={16} className="spin"/> Loading environment data…</td></tr>
                : error
                  ? <tr><td colSpan="7" className="table-message">Unable to load rows. Check that the API is running.</td></tr>
                  : rows.length === 0
                    ? <tr><td colSpan="7" className="table-message">No environments match this filter. Try another state or search term.</td></tr>
                    : rows.map(row => (
                        <tr key={row.learner_id} className={`env-row${row.state === 'failed' ? ' failed-row' : ''}`}>
                          <td>
                            <b>{row.learner_id}</b>
                            <small>{row.learner_name}</small>
                          </td>
                          <td className="env-name">{row.environment_name}</td>
                          <td>
                            <span className={`state-badge ${row.state}`}>
                              <i/> {STATE_LABELS[row.state] || row.state}
                            </span>
                          </td>
                          <td>
                            <div className="progress-cell">
                              <div className="progress-track">
                                <span style={{ width: `${row.progress_percent}%` }}/>
                              </div>
                              <small>{row.progress_percent}% · {row.step_name || `Step ${row.current_step}`} ({row.current_step}/{row.total_steps})</small>
                            </div>
                          </td>
                          <td className={timeClass(row.time_on_step_minutes)}>{row.time_on_step_minutes} min</td>
                          <td className="tabular">{money(row.estimated_spend)}</td>
                          <td className="action-cell">
                            {row.state === 'failed'
                              ? <>
                                  <span className="failure-reason">{row.failure_reason || 'Failure reason not recorded'}</span>
                                  {row.reprovision_count > 0 &&
                                    <span className="reprovision-badge" title="Times reprovisioned">↺ {row.reprovision_count}x</span>}
                                  <button className="action-btn" disabled={busyId === row.learner_id} onClick={() => reprovision(row.learner_id)}>
                                    {busyId === row.learner_id ? 'Working…' : 'Reprovision'}
                                  </button>
                                </>
                              : <span className="no-action">—</span>}
                          </td>
                        </tr>
                      ))}
            </tbody>
          </table>
        </div>

        <div className="table-footer">
          <span>
            Showing <b>{rows.length}</b> of <b>{total}</b> environments
            {stuckOnly && <> · <span className="stuck-active-label">stuck filter active</span></>}
          </span>
          <span>
            <Wifi size={13}/> Polling every 10 s · Last update {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'}
          </span>
        </div>
      </section>

      <footer className="footer-note">
        CLOUDLABS WORKSHOP OPERATIONS <span>·</span> SIMULATED AZURE ENVIRONMENTS <span>·</span> DEMO DATA
      </footer>
    </main>
  </div>
}

function Metric({ label, value, detail, icon, alert, warn }) {
  return (
    <article className={`metric${alert ? ' metric-alert' : warn ? ' metric-warn' : ''}`}>
      <div className="metric-top"><span>{label}</span><i>{icon}</i></div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

export default App
