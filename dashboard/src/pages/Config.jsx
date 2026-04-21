import { useEffect, useState } from 'react'
import { useConfig, useValidateConfig, useSaveConfig } from '../api/config.js'

const ROLES = ['engineer', 'senior_engineer', 'tech_lead', 'architect', 'principal_architect']

export default function Config() {
  const { data: remote, isLoading, error } = useConfig()
  const validate = useValidateConfig()
  const save     = useSaveConfig()

  const [draft,       setDraft]       = useState(null)
  const [validErr,    setValidErr]    = useState(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Populate draft when remote config loads
  useEffect(() => {
    if (remote && !draft) setDraft(JSON.parse(JSON.stringify(remote)))
  }, [remote])

  // Validate on every draft change (debounced)
  useEffect(() => {
    if (!draft) return
    const t = setTimeout(async () => {
      try {
        await validate.mutateAsync(draft)
        setValidErr(null)
      } catch (err) {
        setValidErr(err.body?.errors ?? err.message)
      }
    }, 500)
    return () => clearTimeout(t)
  }, [draft])

  if (isLoading || !draft) return <p className="text-sm text-gray-600 py-8 text-center">Loading config…</p>
  if (error) return <p className="text-sm text-red-400 py-4">{error.message}</p>

  async function handleSave() {
    setSaveSuccess(false)
    try {
      await save.mutateAsync(draft)
      setSaveSuccess(true)
    } catch (err) {
      setValidErr(err.message)
    }
  }

  function updateMember(idx, field, value) {
    setDraft((d) => {
      const members = [...(d.members ?? [])]
      members[idx] = { ...members[idx], [field]: value }
      return { ...d, members }
    })
  }

  function addMember() {
    setDraft((d) => ({
      ...d,
      members: [...(d.members ?? []), { github_username: '', role: 'engineer', team: '', base_confidence: 0.7 }],
    }))
  }

  function removeMember(idx) {
    setDraft((d) => ({ ...d, members: d.members.filter((_, i) => i !== idx) }))
  }

  const canSave = !validErr && !save.isPending

  return (
    <div className="space-y-6 max-w-3xl">

      {/* Members table */}
      <Card title="Members">
        <div className="space-y-2">
          {(draft.members ?? []).map((m, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-center">
              <input
                value={m.github_username}
                onChange={(e) => updateMember(i, 'github_username', e.target.value)}
                placeholder="github_username"
                className="col-span-3 input-sm"
              />
              <select
                value={m.role}
                onChange={(e) => updateMember(i, 'role', e.target.value)}
                className="col-span-3 input-sm"
              >
                {ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </select>
              <input
                value={m.team ?? ''}
                onChange={(e) => updateMember(i, 'team', e.target.value)}
                placeholder="team"
                className="col-span-3 input-sm"
              />
              <input
                type="number" min={0} max={1} step={0.05}
                value={m.base_confidence ?? 0.7}
                onChange={(e) => updateMember(i, 'base_confidence', parseFloat(e.target.value))}
                className="col-span-2 input-sm"
              />
              <button
                onClick={() => removeMember(i)}
                className="col-span-1 text-xs text-gray-500 hover:text-red-400 text-right"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={addMember}
            className="text-xs text-blue-400 hover:text-blue-300 mt-2"
          >
            + Add member
          </button>
        </div>
      </Card>

      {/* Raw JSON editor for advanced settings */}
      <Card title="Raw config (advanced)">
        <textarea
          rows={14}
          value={JSON.stringify(draft, null, 2)}
          onChange={(e) => {
            try { setDraft(JSON.parse(e.target.value)) } catch {}
          }}
          className="w-full rounded-md bg-gray-950 border border-gray-700 px-3 py-2 text-xs font-mono text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          spellCheck={false}
        />
      </Card>

      {/* Validation errors */}
      {validErr && (
        <div className="rounded-md bg-red-900/20 border border-red-800 px-4 py-3 text-xs text-red-400">
          {typeof validErr === 'string' ? validErr : JSON.stringify(validErr, null, 2)}
        </div>
      )}

      {saveSuccess && (
        <div className="rounded-md bg-green-900/20 border border-green-800 px-4 py-2 text-xs text-green-400">
          Config saved successfully.
        </div>
      )}

      {/* Save */}
      <div className="flex justify-end">
        <button
          disabled={!canSave}
          onClick={handleSave}
          className="rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-5 py-2 text-sm font-medium text-white transition-colors"
        >
          {save.isPending ? 'Saving…' : 'Save config'}
        </button>
      </div>

    </div>
  )
}

function Card({ title, children }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
      <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500">{title}</h2>
      {children}
    </div>
  )
}
