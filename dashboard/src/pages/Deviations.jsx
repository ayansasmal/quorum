/**
 * Deviations page — Wave C+D
 *
 * Lists open deviations from linked global catalogs.
 * Architect-tier users can accept / deny / defer each deviation.
 *
 * Sections:
 *   - Filter rail  (status, topic, severity, source)
 *   - Deviation table with inline action panel for OPEN / OVERDUE rows
 *
 * TODO (Wave E): add UNCERTIFIED banner when GET /api/conformance returns
 *   { status: 'UNCERTIFIED' } — requires the conformance endpoint to land first.
 */

import { Fragment, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, X } from 'lucide-react'
import { useDeviations, useDeviationAction } from '../api/deviations.js'
import { useAuth } from '../context/AuthContext.jsx'
import ConfidenceBar from '../components/stats/ConfidenceBar.jsx'
import { fmtDate } from '../lib/utils.js'

/** Roles that may action deviations — mirrors enforceDeviationActionAuthority. */
const ACTIONABLE_ROLES = ['architect', 'principal_architect', 'product_owner', 'compliance_officer']

const VALID_DEFER_DAYS = [30, 45, 60, 90]

const STATUS_COLORS = {
  OPEN:     'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  ACCEPTED: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800',
  DENIED:   'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800',
  DEFERRED: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800',
  OVERDUE:  'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800',
  RESOLVED: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-gray-200 dark:border-gray-700',
}

const SOURCE_COLORS = {
  'agent':           'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  'code-review':     'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  'security-review': 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
}

const STATUS_OPTIONS = ['', 'OPEN', 'ACCEPTED', 'DENIED', 'DEFERRED', 'OVERDUE', 'RESOLVED']
const SOURCE_OPTIONS = ['', 'agent', 'code-review', 'security-review']

export default function Deviations() {
  const { currentProjectData } = useAuth()
  const role                   = currentProjectData?.role ?? ''
  const canAction              = ACTIONABLE_ROLES.includes(role)

  // ── Filters ────────────────────────────────────────────────────────────────
  const [filters, setFilters] = useState({ status: 'OPEN', topic: '', source: '', severity_min: '' })

  const activeFilters = {
    ...(filters.status       ? { status:       filters.status       } : {}),
    ...(filters.topic        ? { topic:         filters.topic        } : {}),
    ...(filters.source       ? { source:        filters.source       } : {}),
    ...(filters.severity_min ? { severity_min:  Number(filters.severity_min) } : {}),
  }

  const { data, isLoading, error } = useDeviations(activeFilters)
  const deviationAction            = useDeviationAction()

  // ── Inline action panel state ──────────────────────────────────────────────
  const [expandedId,  setExpandedId]  = useState(null)
  const [actionType,  setActionType]  = useState(null)   // 'accept' | 'deny' | 'defer'
  const [reason,      setReason]      = useState('')
  const [deferDays,   setDeferDays]   = useState(30)

  function toggleRow(deviationId) {
    if (expandedId === deviationId) {
      closePanel()
    } else {
      setExpandedId(deviationId)
      setActionType(null)
      setReason('')
      setDeferDays(30)
      deviationAction.reset()
    }
  }

  function closePanel() {
    setExpandedId(null)
    setActionType(null)
    setReason('')
    setDeferDays(30)
    deviationAction.reset()
  }

  async function submitAction(deviationId) {
    if (!actionType) return
    if (reason.trim().length < 10) return

    let deferUntil = undefined
    if (actionType === 'defer') {
      const d = new Date()
      d.setDate(d.getDate() + deferDays)
      deferUntil = d.toISOString()
    }

    await deviationAction.mutateAsync({
      id:          deviationId,
      action_type: actionType,
      reason:      reason.trim(),
      defer_until: deferUntil,
    })

    closePanel()
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const deviations = data?.deviations ?? []

  return (
    <div className="space-y-4 max-w-6xl">

      {/* ── Filter rail ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Status */}
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-400"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s || 'All statuses'}</option>
          ))}
        </select>

        {/* Topic */}
        <input
          type="text"
          placeholder="Topic…"
          value={filters.topic}
          onChange={(e) => setFilters((f) => ({ ...f, topic: e.target.value }))}
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-400 w-32"
        />

        {/* Source */}
        <select
          value={filters.source}
          onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value }))}
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-400"
        >
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>{s || 'All sources'}</option>
          ))}
        </select>

        {/* Min severity */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 whitespace-nowrap">Min severity</label>
          <input
            type="number"
            min="0"
            max="1"
            step="0.1"
            placeholder="0.0"
            value={filters.severity_min}
            onChange={(e) => setFilters((f) => ({ ...f, severity_min: e.target.value }))}
            className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-400 w-20"
          />
        </div>

        {/* Clear filters */}
        {(filters.status || filters.topic || filters.source || filters.severity_min) && (
          <button
            onClick={() => setFilters({ status: '', topic: '', source: '', severity_min: '' })}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        )}
      </div>

      {/* ── States ──────────────────────────────────────────────────────── */}
      {isLoading && (
        <div className="text-sm text-gray-600 py-8 text-center">Loading deviations…</div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">
          Failed to load deviations: {error.message}
        </div>
      )}

      {!isLoading && !error && deviations.length === 0 && (
        <div className="flex flex-col items-center justify-center h-48 gap-3 text-gray-500">
          <AlertTriangle className="h-8 w-8 opacity-30" />
          <p className="text-sm">No deviations match the current filters.</p>
        </div>
      )}

      {/* ── Deviation table ──────────────────────────────────────────────── */}
      {!isLoading && !error && deviations.length > 0 && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 dark:border-gray-800">
              <tr>
                {[
                  'Catalog / Topic / Key',
                  'Description',
                  'Severity',
                  'Source',
                  'Status',
                  'First seen',
                  'Last seen',
                  ...(canAction ? [''] : []),
                ].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {deviations.map((dev) => {
                const isExpanded   = expandedId === dev.deviation_id
                const isActionable = canAction && (dev.status === 'OPEN' || dev.status === 'OVERDUE')
                const reasonValid  = reason.trim().length >= 10

                return (
                  <Fragment key={dev.deviation_id}>
                    {/* ── Main row ─────────────────────────────────────── */}
                    <tr
                      className={`border-b border-gray-200/50 dark:border-gray-800/50 align-top
                        ${isExpanded ? 'bg-gray-50 dark:bg-gray-800/40' : 'hover:bg-gray-50/60 dark:hover:bg-gray-800/20'}`}
                    >
                      {/* Catalog / Topic / Key */}
                      <td className="px-4 py-2.5 font-mono text-xs">
                        <span className="text-gray-400">{dev.catalog_id}</span>
                        <br />
                        <span className="text-gray-500">{dev.topic}</span>
                        {' / '}
                        <span className="text-blue-400">{dev.key}</span>
                      </td>

                      {/* Description */}
                      <td className="px-4 py-2.5 text-xs text-gray-700 dark:text-gray-300 max-w-[260px]">
                        <span className="line-clamp-2">{dev.description}</span>
                      </td>

                      {/* Severity bar */}
                      <td className="px-4 py-2.5 min-w-[110px]">
                        <ConfidenceBar value={dev.severity} showLabel />
                      </td>

                      {/* Source badge */}
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium
                          ${SOURCE_COLORS[dev.source] ?? SOURCE_COLORS['agent']}`}>
                          {dev.source ?? 'agent'}
                        </span>
                      </td>

                      {/* Status badge */}
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium
                          ${STATUS_COLORS[dev.status] ?? STATUS_COLORS['OPEN']}`}>
                          {dev.status ?? 'OPEN'}
                        </span>
                      </td>

                      {/* First seen */}
                      <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                        {fmtDate(dev.first_seen_at)}
                      </td>

                      {/* Last seen */}
                      <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                        {fmtDate(dev.last_seen_at)}
                      </td>

                      {/* Action toggle */}
                      {canAction && (
                        <td className="px-4 py-2.5">
                          {isActionable ? (
                            <button
                              onClick={() => toggleRow(dev.deviation_id)}
                              className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 border border-blue-200 dark:border-blue-800"
                            >
                              Action
                              {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                            </button>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>
                      )}
                    </tr>

                    {/* ── Inline action panel ───────────────────────── */}
                    {isExpanded && (
                      <tr
                        className="border-b border-blue-100 dark:border-blue-900/30 bg-blue-50/40 dark:bg-blue-950/20">
                        <td colSpan={canAction ? 8 : 7} className="px-4 py-4">
                          <div className="space-y-3 max-w-xl">

                            {/* Action type selector */}
                            <div className="flex gap-2">
                              {['accept', 'deny', 'defer'].map((type) => (
                                <button
                                  key={type}
                                  onClick={() => { setActionType(type); setReason('') }}
                                  className={`rounded px-3 py-1.5 text-xs font-medium capitalize transition-colors
                                    ${actionType === type
                                      ? type === 'accept' ? 'bg-green-600 text-white'
                                        : type === 'deny' ? 'bg-red-600 text-white'
                                        : 'bg-amber-500 text-white'
                                      : 'border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                                    }`}
                                >
                                  {type}
                                </button>
                              ))}
                            </div>

                            {/* Defer duration (only when defer selected) */}
                            {actionType === 'defer' && (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-gray-500">Defer for:</span>
                                {VALID_DEFER_DAYS.map((d) => (
                                  <button
                                    key={d}
                                    onClick={() => setDeferDays(d)}
                                    className={`rounded px-2.5 py-1 text-xs font-medium transition-colors
                                      ${deferDays === d
                                        ? 'bg-amber-500 text-white'
                                        : 'border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                                      }`}
                                  >
                                    {d}d
                                  </button>
                                ))}
                              </div>
                            )}

                            {/* Deny hint — shows when global standard has high-confidence PA authorship */}
                            {actionType === 'deny' && dev.denial_hint && (
                              <div className="rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                                ⚠ {dev.denial_hint}
                              </div>
                            )}

                            {/* Reason textarea */}
                            {actionType && (
                              <div className="space-y-1">
                                <textarea
                                  rows={2}
                                  placeholder="Reason (required, minimum 10 characters)…"
                                  value={reason}
                                  onChange={(e) => setReason(e.target.value)}
                                  className={`w-full rounded-md border px-3 py-2 text-sm resize-none
                                    bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300
                                    focus:outline-none focus:ring-1 focus:ring-blue-400
                                    ${reason.length > 0 && !reasonValid
                                      ? 'border-red-400 dark:border-red-600'
                                      : 'border-gray-200 dark:border-gray-700'
                                    }`}
                                />
                                {reason.length > 0 && !reasonValid && (
                                  <p className="text-[11px] text-red-500">
                                    Reason must be at least 10 characters ({reason.trim().length}/10).
                                  </p>
                                )}
                              </div>
                            )}

                            {/* Submit / cancel row */}
                            {actionType && (
                              <div className="flex items-center gap-2">
                                <button
                                  disabled={!reasonValid || deviationAction.isPending}
                                  onClick={() => submitAction(dev.deviation_id)}
                                  className="rounded px-3 py-1.5 text-xs font-medium bg-blue-600 text-white
                                    hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                >
                                  {deviationAction.isPending ? 'Saving…' : `Submit ${actionType}`}
                                </button>
                                <button
                                  onClick={closePanel}
                                  className="rounded px-3 py-1.5 text-xs font-medium text-gray-500
                                    hover:text-gray-700 dark:hover:text-gray-300"
                                >
                                  Cancel
                                </button>
                                {deviationAction.error && (
                                  <span className="text-xs text-red-500">{deviationAction.error.message}</span>
                                )}
                              </div>
                            )}

                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
