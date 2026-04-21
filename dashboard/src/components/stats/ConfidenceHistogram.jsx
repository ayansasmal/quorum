export default function ConfidenceHistogram({ confidence }) {
  if (!confidence) return null
  const { high = 0, medium = 0, low = 0 } = confidence
  const total = high + medium + low || 1

  const bars = [
    { label: '>70%',   value: high,   color: 'bg-green-500' },
    { label: '40–70%', value: medium, color: 'bg-amber-500' },
    { label: '<40%',   value: low,    color: 'bg-red-500'   },
  ]

  return (
    <div className="space-y-2">
      {bars.map(({ label, value, color }) => (
        <div key={label} className="flex items-center gap-3 text-xs">
          <span className="w-14 text-gray-400 text-right tabular-nums">{label}</span>
          <div className="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden">
            <div
              className={`h-full rounded-full ${color}`}
              style={{ width: `${(value / total) * 100}%` }}
            />
          </div>
          <span className="w-8 text-gray-500 tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  )
}
