import { useState, useEffect, useRef } from 'react';
import { Search, Trash2, ThumbsUp } from 'lucide-react';
import {
  useKnowledge,
  useSearch,
  useKnowledgeWrite,
} from '../api/knowledge.js';
import { useStats } from '../api/stats.js';
import { useAuth } from '../context/AuthContext.jsx';
import KnowledgeDetail from '../components/knowledge/KnowledgeDetail.jsx';
import KnowledgeForm from '../components/knowledge/KnowledgeForm.jsx';
import ConfirmDialog from '../components/knowledge/ConfirmDialog.jsx';
import DeprecateDialog from '../components/knowledge/DeprecateDialog.jsx';
import ConfidenceBar from '../components/stats/ConfidenceBar.jsx';
import { entityBadge, fmtDate } from '../lib/utils.js';

const ENTITY_TYPES = [
  'Decision',
  'Pattern',
  'Constraint',
  'Runbook',
  'Requirement',
];

export default function Knowledge() {
  const [domain, setDomain] = useState('');
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [promoteTarget, setPromoteTarget] = useState(null);
  const [checkedRows, setCheckedRows] = useState(new Set());
  const [deprecateTarget, setDeprecateTarget] = useState(null);
  const [writeSuccess, setWriteSuccess] = useState(null);
  const successTimerRef = useRef(null);

  const { currentProjectData } = useAuth();
  const isPE = currentProjectData?.role === 'principal_architect';

  const write = useKnowledgeWrite(() => {
    clearTimeout(successTimerRef.current);
    setWriteSuccess('Saved.');
    successTimerRef.current = setTimeout(() => setWriteSuccess(null), 3000);
  });

  useEffect(() => () => clearTimeout(successTimerRef.current), []);

  function handleBulkDeprecate() {
    const entries = Array.from(checkedRows).map((id) => {
      const [topic, ...keyParts] = id.split(':');
      return { topic, key: keyParts.join(':') };
    });
    setDeprecateTarget({ entries });
  }

  const isSearching = query.trim().length >= 2;

  const { data: statsData } = useStats();
  const domainOptions = (statsData?.domains ?? []).map(d => d.domain);

  const browseResult = useKnowledge({
    domain,
    entity_type: entityType,
    page,
    limit: 20,
  });
  const searchResult = useSearch(isSearching ? query : '', domain);

  const { data, isLoading, error } = isSearching ? searchResult : browseResult;

  const items = isSearching ? (data?.results ?? []) : (data?.items ?? []);

  return (
    <div className="space-y-4 max-w-5xl">
      {/* Filters + search bar */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search by tag, key, or topic…"
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 pl-9 pr-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={domain}
          onChange={e => {
            setDomain(e.target.value);
            setPage(1);
          }}
          className="rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-300"
        >
          <option value="">All domains</option>
          {domainOptions.map(d => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select
          value={entityType}
          onChange={e => {
            setEntityType(e.target.value);
            setPage(1);
          }}
          className="rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-300"
        >
          <option value="">All types</option>
          {ENTITY_TYPES.map(t => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowCreateForm(true)}
          className="rounded-md bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium"
        >
          + Add entry
        </button>
      </div>

      {/* Success banner */}
      {writeSuccess && (
        <p className="text-sm text-green-600 dark:text-green-400">
          {writeSuccess}
        </p>
      )}

      {/* Results */}
      {isLoading ? (
        <p className="text-sm text-gray-600 py-8 text-center">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-400 py-4">{error.message}</p>
      ) : !items.length ? (
        <p className="text-sm text-gray-600 py-8 text-center">
          No knowledge found.
        </p>
      ) : (
        <>
        {/* Bulk action bar — shown when PE has selected rows */}
        {isPE && checkedRows.size > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
            <span className="text-blue-700 dark:text-blue-300 font-medium">{checkedRows.size} selected</span>
            <button
              onClick={handleBulkDeprecate}
              className="flex items-center gap-1.5 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-medium"
              title="Deprecate selected"
            >
              <Trash2 className="h-4 w-4" />
              Deprecate
            </button>
            <button
              onClick={() => setCheckedRows(new Set())}
              className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Clear
            </button>
          </div>
        )}

        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 dark:border-gray-800">
              <tr>
                {isPE && <th className="px-3 py-2.5 w-8" />}
                {['Domain', 'Key', 'Type', 'Confidence', 'Author', 'Updated'].map(h => (
                  <th
                    key={h}
                    className="px-4 py-2.5 text-left text-xs font-medium text-gray-500"
                  >
                    {h}
                  </th>
                ))}
                {isPE && (
                  <th className="px-2 py-2.5 text-left text-xs font-medium text-gray-500 w-20">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
              {items.map(row => {
                const rowId    = `${row.topic}:${row.key}`;
                const isActive = (row.status ?? 'ACTIVE') === 'ACTIVE';
                const isDraft  = (row.status ?? 'ACTIVE') === 'DRAFT';
                return (
                  <tr
                    key={rowId}
                    onClick={() => setSelected(row)}
                    className="hover:bg-gray-100/40 dark:hover:bg-gray-800/40 cursor-pointer"
                  >
                    {isPE && (
                      <td
                        className="px-3 py-2.5 w-8"
                        onClick={e => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={checkedRows.has(rowId)}
                          onChange={e => {
                            e.stopPropagation();
                            setCheckedRows(prev => {
                              const next = new Set(prev);
                              if (next.has(rowId)) next.delete(rowId);
                              else next.add(rowId);
                              return next;
                            });
                          }}
                          className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                    )}
                    <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 font-mono text-xs">
                      {row.topic}
                    </td>
                    <td className="px-4 py-2.5 text-blue-400 font-mono text-xs">
                      {row.key}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${entityBadge(row.entity_type)}`}
                      >
                        {row.entity_type}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 min-w-[120px]">
                      <ConfidenceBar value={row.confidence} showLabel />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">
                      {row.author}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">
                      {fmtDate(row.updated_at)}
                    </td>
                    {isPE && (
                      <td
                        className="px-2 py-2.5 w-20"
                        onClick={e => e.stopPropagation()}
                      >
                        <div className="flex items-center gap-1">
                          {isActive && (
                            <>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  setDeprecateTarget({ entries: [{ topic: row.topic, key: row.key }] });
                                }}
                                className="rounded p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                                title="Deprecate"
                                aria-label="Deprecate entry"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  write.bump.mutateAsync({ topic: row.topic, key: row.key });
                                }}
                                className="rounded p-1 text-gray-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20"
                                title="Bump confidence"
                                aria-label="Bump confidence"
                              >
                                <ThumbsUp className="h-4 w-4" />
                              </button>
                            </>
                          )}
                          {isDraft && (
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                setPromoteTarget(row);
                              }}
                              className="text-xs text-green-600 hover:text-green-700 dark:text-green-400 font-medium px-1"
                            >
                              Promote
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}

      {/* Pagination (browse mode only) */}
      {!isSearching && data?.pages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{data.total} total</span>
          <div className="flex gap-2">
            <button
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
              className="px-3 py-1 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40"
            >
              Prev
            </button>
            <span className="px-2 py-1">
              Page {page} of {data.pages}
            </span>
            <button
              disabled={page >= data.pages}
              onClick={() => setPage(p => p + 1)}
              className="px-3 py-1 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Deprecate dialog — single entry or bulk */}
      {deprecateTarget && (
        <DeprecateDialog
          entries={deprecateTarget.entries}
          onConfirm={async (reason) => {
            if (deprecateTarget.entries.length === 1) {
              const { topic, key } = deprecateTarget.entries[0];
              await write.deprecate.mutateAsync({ topic, key, reason });
              write.deprecate.reset();
            } else {
              await write.deprecateBulk.mutateAsync({ entries: deprecateTarget.entries, reason });
              write.deprecateBulk.reset();
            }
            setDeprecateTarget(null);
            setCheckedRows(new Set());
          }}
          onCancel={() => {
            write.deprecate.reset();
            write.deprecateBulk.reset();
            setDeprecateTarget(null);
          }}
          isSubmitting={write.deprecate.isPending || write.deprecateBulk.isPending}
          error={write.deprecate.error?.message ?? write.deprecateBulk.error?.message ?? null}
        />
      )}

      {/* Detail panel */}
      {selected && (
        <KnowledgeDetail row={selected} onClose={() => setSelected(null)} />
      )}

      {/* Create form modal */}
      {showCreateForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg p-4 bg-white dark:bg-gray-900 rounded-lg shadow-2xl">
            <KnowledgeForm
              mode="create"
              onSubmit={async fields => {
                await write.create.mutateAsync(fields);
                write.create.reset();
                setShowCreateForm(false);
              }}
              onCancel={() => {
                write.create.reset();
                setShowCreateForm(false);
              }}
              isSubmitting={write.create.isPending}
              error={write.create.error?.message ?? null}
            />
          </div>
        </div>
      )}

      {/* Supersede (edit) form modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg p-4 bg-white dark:bg-gray-900 rounded-lg shadow-2xl">
            <KnowledgeForm
              mode="supersede"
              initialValues={{
                topic: editTarget.topic,
                key: editTarget.key,
                content: editTarget.summary ?? editTarget.content ?? '',
                entity_type: editTarget.entity_type,
                tags: editTarget.tags ?? [],
                confidence: editTarget.confidence ?? 0.85,
              }}
              onSubmit={async fields => {
                await write.supersede.mutateAsync({
                  topic: editTarget.topic,
                  key: editTarget.key,
                  ...fields,
                });
                write.supersede.reset();
                setEditTarget(null);
              }}
              onCancel={() => {
                write.supersede.reset();
                setEditTarget(null);
              }}
              isSubmitting={write.supersede.isPending}
              error={write.supersede.error?.message ?? null}
            />
          </div>
        </div>
      )}

      {/* Promote confirm dialog */}
      {promoteTarget && (
        <ConfirmDialog
          open={Boolean(promoteTarget)}
          title="Promote to Active?"
          body={`Promote ${promoteTarget.topic}:${promoteTarget.key} to Active? It will replace any existing Active version.`}
          confirmLabel="Promote"
          noteLabel="Reason for promoting"
          noteRequired={true}
          onConfirm={async note => {
            await write.promote.mutateAsync({
              topic: promoteTarget.topic,
              key: promoteTarget.key,
              note,
            });
            write.promote.reset();
            setPromoteTarget(null);
          }}
          onCancel={() => {
            write.promote.reset();
            setPromoteTarget(null);
          }}
          isSubmitting={write.promote.isPending}
          error={write.promote.error?.message ?? null}
        />
      )}
    </div>
  );
}
