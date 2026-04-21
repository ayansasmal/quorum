export default function ConflictDiff({ existing, incoming }) {
  return (
    <div className="grid grid-cols-2 gap-3 text-xs">
      <div className="space-y-1.5">
        <p className="font-medium text-gray-500 uppercase tracking-wider">Existing (ACTIVE)</p>
        <pre className="whitespace-pre-wrap rounded-md bg-gray-950 border border-gray-800 p-3 text-gray-300 leading-relaxed font-mono">
          {existing ?? <span className="text-gray-600 italic">none</span>}
        </pre>
      </div>
      <div className="space-y-1.5">
        <p className="font-medium text-amber-500 uppercase tracking-wider">Incoming (DRAFT)</p>
        <pre className="whitespace-pre-wrap rounded-md bg-amber-950/20 border border-amber-900/40 p-3 text-gray-300 leading-relaxed font-mono">
          {incoming ?? <span className="text-gray-600 italic">none</span>}
        </pre>
      </div>
    </div>
  )
}
