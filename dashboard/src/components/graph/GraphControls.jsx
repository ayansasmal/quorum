export default function GraphControls({ domain, onDomainChange }) {
  const DOMAINS = ['auth', 'api', 'db', 'infra', 'testing']

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <select
        value={domain}
        onChange={(e) => onDomainChange(e.target.value)}
        className="rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">Select domain to load graph</option>
        {DOMAINS.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      <span className="text-xs text-gray-600">Click a node to inspect · Scroll to zoom · Drag to pan</span>
    </div>
  )
}
