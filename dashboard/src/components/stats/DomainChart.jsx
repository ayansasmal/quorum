import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#6b7280', '#ec4899', '#14b8a6']

export default function DomainChart({ domains = [] }) {
  if (!domains.length) return <Empty />

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={domains} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <XAxis dataKey="domain" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#e5e7eb' }}
          itemStyle={{ color: '#93c5fd' }}
        />
        <Bar dataKey="active_count" name="Active" radius={[3, 3, 0, 0]}>
          {domains.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function Empty() {
  return (
    <div className="flex h-[180px] items-center justify-center text-sm text-gray-600">
      No domain data
    </div>
  )
}
