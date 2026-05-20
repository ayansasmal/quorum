import { useState } from 'react'
import { useAdminConfig, useAdminUsers, useAdminProjects, useArchiveProject } from '../api/governance.js'
import { useAuth } from '../context/AuthContext.jsx'
import ConfirmDialog from '../components/knowledge/ConfirmDialog.jsx'

/**
 * Admin page — platform admin management.
 * Only visible when user.is_admin is true; the gateway enforces this server-side too.
 */
export default function Admin() {
  const { user } = useAuth()
  const { data: adminConfig, isLoading, error } = useAdminConfig()
  const { data: projectsData }                  = useAdminProjects()
  const adminUsers    = useAdminUsers()
  const archiveProject = useArchiveProject()

  const [addUsername,  setAddUsername]  = useState('')
  const [addReason,    setAddReason]    = useState('')
  const [removeMsg,    setRemoveMsg]    = useState({})  // { [username]: { ok, text } }
  const [addMsg,       setAddMsg]       = useState(null)
  const [archivingId,  setArchivingId]  = useState(null)  // project id pending confirmation
  const [archiveError, setArchiveError] = useState(null)

  if (!user?.is_admin) {
    return (
      <p className="text-sm text-red-400 py-8 text-center">
        Access denied — platform admin only.
      </p>
    )
  }

  if (isLoading) return <p className="text-sm text-gray-600 py-8 text-center">Loading…</p>
  if (error)     return <p className="text-sm text-red-400 py-4">{error.message}</p>

  const admins = adminConfig?.admins ?? []

  /**
   * Add a new platform admin.
   */
  async function handleAdd() {
    setAddMsg(null)
    try {
      await adminUsers.mutateAsync({ action: 'add', github_username: addUsername, reason: addReason })
      setAddMsg({ ok: true, text: `${addUsername} added as platform admin.` })
      setAddUsername('')
      setAddReason('')
    } catch (err) {
      setAddMsg({ ok: false, text: err.message })
    }
  }

  /**
   * Remove an existing platform admin.
   * @param {string} username
   */
  async function handleRemove(username) {
    setRemoveMsg((prev) => ({ ...prev, [username]: null }))
    try {
      await adminUsers.mutateAsync({
        action: 'remove',
        github_username: username,
        reason: `Removed by ${user.sub} via admin panel`,
      })
      setRemoveMsg((prev) => ({ ...prev, [username]: { ok: true, text: 'Removed.' } }))
    } catch (err) {
      setRemoveMsg((prev) => ({ ...prev, [username]: { ok: false, text: err.message } }))
    }
  }

  /**
   * @param {string} reason - Deprecation reason from ConfirmDialog
   */
  async function handleArchive(reason) {
    setArchiveError(null)
    try {
      await archiveProject.mutateAsync({ id: archivingId, reason })
      setArchivingId(null)
    } catch (err) {
      setArchiveError(err.message)
    }
  }

  const projects = projectsData?.projects ?? []

  return (
    <div className="space-y-6 max-w-2xl">

      {/* Current admins */}
      <Card title="Platform admins">
        {admins.length === 0 ? (
          <p className="text-xs text-gray-500">No admins configured.</p>
        ) : (
          <div className="space-y-2">
            {admins.map((a) => (
              <div key={a.github_username} className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
                    {a.github_username}
                  </span>
                  <span className="ml-3 text-xs text-gray-400">
                    added {new Date(a.added_at).toLocaleDateString()} by {a.added_by}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {removeMsg[a.github_username] && (
                    <span className={`text-xs ${removeMsg[a.github_username].ok ? 'text-green-500' : 'text-red-400'}`}>
                      {removeMsg[a.github_username].text}
                    </span>
                  )}
                  {a.github_username !== user.sub && (
                    <button
                      onClick={() => handleRemove(a.github_username)}
                      disabled={adminUsers.isPending}
                      className="text-xs text-gray-400 hover:text-red-400 disabled:opacity-40 transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Add admin */}
      <Card title="Add platform admin">
        <div className="grid grid-cols-12 gap-2 items-end">
          <input
            value={addUsername}
            onChange={(e) => setAddUsername(e.target.value)}
            placeholder="GitHub username"
            className="col-span-4 input-sm"
          />
          <input
            value={addReason}
            onChange={(e) => setAddReason(e.target.value)}
            placeholder="Reason (≥ 10 chars)"
            className="col-span-6 input-sm"
          />
          <button
            disabled={!addUsername || addReason.length < 10 || adminUsers.isPending}
            onClick={handleAdd}
            className="col-span-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-3 py-1 text-xs font-medium text-white"
          >
            {adminUsers.isPending ? '…' : 'Add'}
          </button>
        </div>
        {addMsg && (
          <p className={`text-xs mt-2 ${addMsg.ok ? 'text-green-500' : 'text-red-400'}`}>
            {addMsg.text}
          </p>
        )}
      </Card>

      {/* Projects */}
      <Card title="Projects">
        {projects.length === 0 ? (
          <p className="text-xs text-gray-500">No projects found.</p>
        ) : (
          <div className="space-y-2">
            {projects.map((p) => (
              <div key={p.id} className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
                    {p.name ?? p.slug}
                  </span>
                  <span className="ml-2 text-xs text-gray-400">{p.slug}</span>
                  <span className="ml-3 text-xs text-gray-400">
                    {p.member_count} member{p.member_count !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {p.status === 'ARCHIVED' ? (
                    <span className="text-xs text-gray-400 italic">Archived</span>
                  ) : (
                    <button
                      onClick={() => { setArchiveError(null); setArchivingId(p.id) }}
                      className="text-xs text-gray-400 hover:text-red-400 transition-colors"
                    >
                      Deprecate
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={!!archivingId}
        title="Deprecate project"
        body={`This will archive the project and deprecate all its ACTIVE knowledge entries. This cannot be undone.`}
        confirmLabel="Deprecate"
        destructive
        noteLabel="Reason for deprecation"
        noteRequired
        onConfirm={handleArchive}
        onCancel={() => { setArchivingId(null); setArchiveError(null) }}
        isSubmitting={archiveProject.isPending}
        error={archiveError}
      />

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
