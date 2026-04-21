import { useHealth } from '../api/health.js'
import { useStats } from '../api/stats.js'
import ServiceIndicator from '../components/status/ServiceIndicator.jsx'
import { fmtDate } from '../lib/utils.js'

export default function Status() {
  const { data: health, isLoading: healthLoading } = useHealth()
  const { data: stats } = useStats()

  const components = health?.components ?? {}
  const gatewayOk  = !healthLoading  // if this page loaded, gateway is up

  const totalActive    = stats?.domains?.reduce((s, d) => s + (d.active_count ?? 0), 0) ?? 0
  const totalDraft     = stats?.domains?.reduce((s, d) => s + (d.draft_count  ?? 0), 0) ?? 0
  const pendingCount   = stats?.pending?.total ?? 0

  return (
    <div className="space-y-6 max-w-2xl">

      {/* Service health */}
      <Card title="Service health">
        <ServiceIndicator name="Gateway"    status={gatewayOk ? 'healthy' : 'unavailable'} detail="This page loaded" />
        <ServiceIndicator name="Graphiti"   status={components.graphiti   ?? 'unknown'} />
        <ServiceIndicator name="FalkorDB"   status={components.graphiti === 'connected' ? 'connected' : 'unknown'} detail="via Graphiti" />
        <ServiceIndicator name="PostgreSQL" status={components.postgresql ?? 'unknown'} />
        <ServiceIndicator name="Quorum MCP" status="connected" detail={`v${health?.version ?? '—'}`} />
      </Card>

      {/* Operational indicators */}
      <Card title="Operational indicators">
        <Indicator label="Pending decisions" value={pendingCount} warn={pendingCount > 0} />
        <Indicator label="Active knowledge nodes" value={totalActive} />
        <Indicator label="Draft knowledge nodes"  value={totalDraft} warn={totalDraft > 5} />
        <Indicator label="Last health check" value={health?.timestamp ? fmtDate(health.timestamp) : '—'} />
      </Card>

      {/* Confidence health */}
      {stats?.confidence && (
        <Card title="Confidence health">
          <Indicator label="High confidence (>70%)"    value={stats.confidence.high}   />
          <Indicator label="Medium confidence (40–70%)" value={stats.confidence.medium} />
          <Indicator label="Low confidence (<40%)"      value={stats.confidence.low}    warn={stats.confidence.low > 0} />
        </Card>
      )}

    </div>
  )
}

function Card({ title, children }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-1">
      <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 pb-2">{title}</h2>
      {children}
    </div>
  )
}

function Indicator({ label, value, warn }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-800/50 last:border-0">
      <span className="text-sm text-gray-400">{label}</span>
      <span className={`text-sm font-mono font-medium ${warn ? 'text-amber-400' : 'text-gray-200'}`}>{value ?? '—'}</span>
    </div>
  )
}
