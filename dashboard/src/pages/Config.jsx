import { useEffect, useState } from 'react'
import { useConfig, useValidateConfig, useSaveConfig } from '../api/config.js'
import { useTransferOwnership, useUpdateRole } from '../api/governance.js'
import { useGlobals } from '../api/conformance.js'
import { useAuth } from '../context/AuthContext.jsx'

const ROLES = ['engineer', 'senior_engineer', 'tech_lead', 'architect', 'principal_architect']

export default function Config() {
  const { data: remote, isLoading, error } = useConfig()
  const validate = useValidateConfig()
  const save     = useSaveConfig()
  const transfer = useTransferOwnership()
  const updateRole = useUpdateRole()
  const { data: globalsData } = useGlobals()
  const { user, currentProjectData } = useAuth()

  const isOwner = currentProjectData?.is_owner ?? false
  const isAdmin = user?.is_admin ?? false
  const canGovern = isOwner || isAdmin

  const [draft,       setDraft]       = useState(null)
  const [validErr,    setValidErr]    = useState(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Governance form state
  const [transferTo,     setTransferTo]     = useState('')
  const [transferReason, setTransferReason] = useState('')
  const [transferMsg,    setTransferMsg]    = useState(null)
  const [roleTarget,     setRoleTarget]     = useState('')
  const [roleNew,        setRoleNew]        = useState('engineer')
  const [roleReason,     setRoleReason]     = useState('')
  const [roleMsg,        setRoleMsg]        = useState(null)

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

  if (isLoading) return <p className="text-sm text-gray-600 py-8 text-center">Loading config…</p>
  if (error)     return <p className="text-sm text-red-400 py-4">{error.message}</p>
  if (!draft)    return <p className="text-sm text-gray-600 py-8 text-center">Loading config…</p>

  async function handleTransfer() {
    setTransferMsg(null)
    try {
      await transfer.mutateAsync({ to: transferTo, reason: transferReason })
      setTransferMsg({ ok: true, text: `Ownership transferred to ${transferTo}.` })
      setTransferTo('')
      setTransferReason('')
    } catch (err) {
      setTransferMsg({ ok: false, text: err.message })
    }
  }

  async function handleRoleUpdate() {
    setRoleMsg(null)
    try {
      await updateRole.mutateAsync({ github_username: roleTarget, role: roleNew, reason: roleReason })
      setRoleMsg({ ok: true, text: `Role for ${roleTarget} updated to ${roleNew}.` })
      setRoleReason('')
    } catch (err) {
      setRoleMsg({ ok: false, text: err.message })
    }
  }

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

      {/* Global Catalogs */}
      <Card title="Global catalogs">
        <p className="text-xs text-gray-500 mb-3">
          Link to org-wide catalog projects to enable conformance scoring and deviation tracking.
          Changes take effect when you save the config.
        </p>
        {(() => {
          const available  = globalsData?.catalogs ?? []
          const linked     = draft.globals ?? []
          const currentId  = draft.group_id

          // Exclude self-reference; split into linked vs unlinked
          const eligible   = available.filter(c => c.group_id !== currentId)
          const linkedSet  = new Set(linked)
          const linkedCats = eligible.filter(c => linkedSet.has(c.group_id))
          const available_ = eligible.filter(c => !linkedSet.has(c.group_id))

          function toggle(groupId, add) {
            setDraft(d => ({
              ...d,
              globals: add
                ? [...(d.globals ?? []), groupId]
                : (d.globals ?? []).filter(g => g !== groupId),
            }))
          }

          if (eligible.length === 0) {
            return (
              <p className="text-xs text-gray-400 italic">
                No global catalogs found. Run the seed script or ask your platform admin to create one.
              </p>
            )
          }

          return (
            <div className="space-y-3">
              {/* Linked catalogs */}
              {linkedCats.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Linked</p>
                  <div className="flex flex-wrap gap-2">
                    {linkedCats.map(c => (
                      <span
                        key={c.group_id}
                        className="inline-flex items-center gap-1.5 rounded-full border border-indigo-300 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
                      >
                        {c.display_name ?? c.group_id}
                        <span className="text-[9px] text-indigo-400 dark:text-indigo-500 uppercase">{c.global_scope}</span>
                        <button
                          onClick={() => toggle(c.group_id, false)}
                          className="ml-0.5 text-indigo-400 hover:text-red-500 dark:text-indigo-500 dark:hover:text-red-400 transition-colors"
                          title={`Unlink ${c.group_id}`}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Available catalogs */}
              {available_.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Available</p>
                  <div className="flex flex-wrap gap-2">
                    {available_.map(c => (
                      <button
                        key={c.group_id}
                        onClick={() => toggle(c.group_id, true)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-indigo-400 hover:text-indigo-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-indigo-600 dark:hover:text-indigo-300 transition-colors"
                        title={`${c.entry_count} entries · ${c.global_scope}`}
                      >
                        + {c.display_name ?? c.group_id}
                        <span className="text-[9px] text-gray-400 uppercase">{c.global_scope}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {linkedCats.length === 0 && available_.length === 0 && (
                <p className="text-xs text-gray-400 italic">All available catalogs are already linked.</p>
              )}
            </div>
          )
        })()}
      </Card>

      {/* Raw JSON editor for advanced settings */}
      <Card title="Raw config (advanced)">
        <textarea
          rows={14}
          value={JSON.stringify(draft, null, 2)}
          onChange={(e) => {
            try { setDraft(JSON.parse(e.target.value)) } catch {}
          }}
          className="w-full rounded-md bg-gray-50 dark:bg-gray-950 border border-gray-300 dark:border-gray-700 px-3 py-2 text-xs font-mono text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          spellCheck={false}
        />
      </Card>

      {/* Validation errors */}
      {validErr && (
        <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-xs text-red-700 dark:text-red-400">
          {typeof validErr === 'string' ? validErr : JSON.stringify(validErr, null, 2)}
        </div>
      )}

      {saveSuccess && (
        <div data-testid="save-success" className="rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-4 py-2 text-xs text-green-700 dark:text-green-400">
          Config saved successfully.
        </div>
      )}

      {/* Save */}
      <div className="flex justify-end">
        <button
          data-testid="save-config-btn"
          disabled={!canSave}
          onClick={handleSave}
          className="rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-5 py-2 text-sm font-medium text-white transition-colors"
        >
          {save.isPending ? 'Saving…' : 'Save config'}
        </button>
      </div>

      {/* Governance panels — owner or admin only */}
      {canGovern && (
        <>
          {/* Role editor */}
          <Card title="Update member role">
            <p className="text-xs text-gray-500 mb-3">
              Role changes are audited and invalidate the member&apos;s profile cache immediately.
            </p>
            <div className="grid grid-cols-12 gap-2 items-end">
              <select
                value={roleTarget}
                onChange={(e) => setRoleTarget(e.target.value)}
                className="col-span-4 input-sm"
              >
                <option value="">Select member…</option>
                {(draft?.members ?? []).map((m) => (
                  <option key={m.github_username} value={m.github_username}>
                    {m.github_username}
                  </option>
                ))}
              </select>
              <select
                value={roleNew}
                onChange={(e) => setRoleNew(e.target.value)}
                className="col-span-3 input-sm"
              >
                {ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </select>
              <input
                value={roleReason}
                onChange={(e) => setRoleReason(e.target.value)}
                placeholder="Reason (≥ 10 chars)"
                className="col-span-4 input-sm"
              />
              <button
                disabled={!roleTarget || roleReason.length < 10 || updateRole.isPending}
                onClick={handleRoleUpdate}
                className="col-span-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-2 py-1 text-xs font-medium text-white"
              >
                {updateRole.isPending ? '…' : 'Apply'}
              </button>
            </div>
            {roleMsg && (
              <p className={`text-xs mt-2 ${roleMsg.ok ? 'text-green-500' : 'text-red-400'}`}>
                {roleMsg.text}
              </p>
            )}
          </Card>

          {/* Transfer ownership — owner only (admin can transfer but cannot self-assign) */}
          <Card title="Transfer ownership">
            <p className="text-xs text-gray-500 mb-3">
              Permanently transfers the project owner role. The action is audited and
              takes effect immediately via cache invalidation.
            </p>
            <div className="grid grid-cols-12 gap-2 items-end">
              <input
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
                placeholder="New owner username"
                className="col-span-4 input-sm"
              />
              <input
                value={transferReason}
                onChange={(e) => setTransferReason(e.target.value)}
                placeholder="Reason (≥ 10 chars)"
                className="col-span-6 input-sm"
              />
              <button
                disabled={!transferTo || transferReason.length < 10 || transfer.isPending}
                onClick={handleTransfer}
                className="col-span-2 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-40 px-2 py-1 text-xs font-medium text-white"
              >
                {transfer.isPending ? '…' : 'Transfer'}
              </button>
            </div>
            {transferMsg && (
              <p className={`text-xs mt-2 ${transferMsg.ok ? 'text-green-500' : 'text-red-400'}`}>
                {transferMsg.text}
              </p>
            )}
          </Card>
        </>
      )}

    </div>
  )
}

function Card({ title, children }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
      <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500">{title}</h2>
      {children}
    </div>
  )
}
