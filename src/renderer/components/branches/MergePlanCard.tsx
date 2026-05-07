/**
 * MergePlanCard — side panel for the Branches screen.
 *
 * Shows status (mergiraf / rerere / merge-tree gates), pending-resume
 * banner, dirty-worktree warning, the latest dry-run conflict preview,
 * and the action buttons (Plan / Execute / Suggest / Configure).
 */

import { useEffect, useRef } from 'react'
import { useBranchesStore } from '../../stores/branches-store'

interface Props {
  repoPath: string
}

const sectionStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--border)',
  fontSize: 12,
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-muted)',
  marginBottom: 4,
}

const buttonStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text-primary)',
  padding: '6px 10px',
  fontSize: 12,
  cursor: 'pointer',
  marginRight: 6,
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'var(--accent, #5b8cff)',
  color: '#fff',
  border: '1px solid transparent',
}

export function MergePlanCard({ repoPath }: Props): React.ReactElement | null {
  const slice = useBranchesStore((s) => s.byRepo[repoPath])
  const planAction = useBranchesStore((s) => s.plan)
  const executeAction = useBranchesStore((s) => s.execute)
  const resumeAction = useBranchesStore((s) => s.resume)
  const abortAction = useBranchesStore((s) => s.abort)
  const suggestAction = useBranchesStore((s) => s.suggestEdges)
  const configureAction = useBranchesStore((s) => s.configureRepo)

  // Auto-suggest exactly once per repo per session — gating on
  // `suggestedEdges.length === 0` would refire forever if no overlaps
  // exist, and would also refire after every edge mutation since
  // hydrate clears suggestions briefly mid-flight.
  const autoSuggestedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!slice) return
    if (slice.view.nodes.length < 2) return
    if (autoSuggestedRef.current.has(repoPath)) return
    autoSuggestedRef.current.add(repoPath)
    void suggestAction(repoPath)
  }, [repoPath, slice, suggestAction])

  if (!slice) return null

  const { view, lastPlan, running } = slice
  const totalConflicts = lastPlan?.dryRun.reduce((sum, r) => sum + r.conflictFiles.length, 0) ?? 0

  return (
    <div style={{ overflowY: 'auto', flex: '1 1 0%' }}>
      {view.pendingPlan && (
        <div style={{ ...sectionStyle, background: 'rgba(255,180,0,0.08)' }}>
          <div style={labelStyle}>Plan in flight</div>
          <div>
            Step {view.pendingPlan.currentStep} of {view.pendingPlan.totalSteps}{' '}
            ({view.pendingPlan.status})
          </div>
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={running}
              onClick={() => { void resumeAction(repoPath) }}
            >
              Resume
            </button>
            <button
              type="button"
              style={buttonStyle}
              disabled={running}
              onClick={() => { void abortAction(repoPath) }}
            >
              Abort
            </button>
          </div>
        </div>
      )}

      <div style={sectionStyle}>
        <div style={labelStyle}>Repo gates</div>
        <div>
          merge-tree: {view.mergeTreeSupported ? '✓' : '✗ (git ≥2.38 required)'}
        </div>
        <div>mergiraf: {view.mergirafReady ? '✓' : '✗ (brew install mergiraf)'}</div>
        <div>rerere: {view.rerereEnabled ? '✓' : '✗ (off)'}</div>
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              void configureAction({
                repoPath,
                enableRerere: !view.rerereEnabled,
                installMergiraf: !view.mergirafReady,
              })
            }}
          >
            Configure
          </button>
        </div>
      </div>

      {view.dirtyWorktrees.length > 0 && (
        <div style={{ ...sectionStyle, background: 'rgba(255,80,80,0.08)' }}>
          <div style={labelStyle}>Dirty worktrees</div>
          {view.dirtyWorktrees.map((p) => (
            <div key={p} style={{ fontFamily: 'monospace', fontSize: 11 }}>
              {p.split('/').slice(-3).join('/')}
            </div>
          ))}
          <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>
            Stash or commit before planning.
          </div>
        </div>
      )}

      <div style={sectionStyle}>
        <div style={labelStyle}>Trunk</div>
        <div style={{ fontFamily: 'monospace' }}>{view.trunk}</div>
      </div>

      <div style={sectionStyle}>
        <div style={labelStyle}>Actions</div>
        <button
          type="button"
          style={buttonStyle}
          disabled={running}
          onClick={() => { void planAction(repoPath) }}
        >
          Plan merge
        </button>
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={running || view.dirtyWorktrees.length > 0}
          onClick={() => { void executeAction(repoPath) }}
        >
          {running ? 'Running…' : 'Execute'}
        </button>
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            style={buttonStyle}
            disabled={running}
            onClick={() => { void suggestAction(repoPath) }}
          >
            Refresh suggestions
          </button>
        </div>
      </div>

      {lastPlan && (
        <div style={sectionStyle}>
          <div style={labelStyle}>
            Plan ({lastPlan.plan.steps.length} steps · {totalConflicts} predicted conflicts)
          </div>
          {lastPlan.plan.steps.map((step, i) => {
            const report = lastPlan.dryRun.find((r) => r.step.branch === step.branch)
            return (
              <div key={step.branch} style={{ marginBottom: 6, paddingBottom: 6, borderBottom: '1px dashed var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontFamily: 'monospace' }}>{i + 1}. {step.branch}</span>
                  <span style={{ color: 'var(--text-muted)' }}>group {step.parallelGroup}</span>
                </div>
                {report && report.conflictFiles.length > 0 && (
                  <div style={{ color: 'var(--accent, #f78c2e)', fontSize: 11, marginTop: 2 }}>
                    {report.conflictFiles.length} file(s) conflict: {report.conflictFiles.slice(0, 3).join(', ')}
                    {report.conflictFiles.length > 3 ? '…' : ''}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
