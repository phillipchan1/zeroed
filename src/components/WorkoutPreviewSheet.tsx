import { X, ChevronRight } from 'lucide-react'
import { Button } from './ui'
import type { RoutineRow, ExerciseTemplate } from '../types/database'

interface WorkoutPreviewSheetProps {
  routine: RoutineRow
  onStart: () => void
  onClose: () => void
}

export function WorkoutPreviewSheet({ routine, onStart, onClose }: WorkoutPreviewSheetProps) {
  const exercises = routine.exercises as ExerciseTemplate[]

  return (
    <div className="obs-sheet" onClick={onClose}>
      <div
        className="obs-sheet__inner"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: '85dvh', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
            marginBottom: 16, flexShrink: 0,
          }}
        >
          <div>
            <p
              className="text-xs text-dim"
              style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}
            >
              Session preview
            </p>
            <p style={{ fontWeight: 600, fontSize: 17 }}>{routine.name}</p>
            {routine.intent && (
              <p className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.5 }}>{routine.intent}</p>
            )}
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ padding: 0, height: 28, minWidth: 28, color: 'var(--text-dim)', flexShrink: 0, marginLeft: 12 }}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        {/* Exercise list — scrollable */}
        <div style={{ overflowY: 'auto', flex: 1, marginBottom: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {exercises.map((ex, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                  gap: 12, padding: '10px 0',
                  borderBottom: i < exercises.length - 1 ? '1px solid var(--line)' : 'none',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 14, fontWeight: 500 }}>{ex.name}</p>
                  {ex.cue && (
                    <p className="text-xs text-dim" style={{ marginTop: 2, lineHeight: 1.4 }}>{ex.cue}</p>
                  )}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <p className="num text-sm" style={{ color: 'var(--signal)' }}>
                    {ex.sets}×{ex.reps}
                  </p>
                  {ex.load && (
                    <p className="text-xs text-dim" style={{ marginTop: 1 }}>{ex.load}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA — sticky at bottom */}
        <div style={{ flexShrink: 0 }}>
          <div
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--line)',
            }}
          >
            <span className="text-xs text-dim">
              <span className="num">{exercises.length}</span> exercises
            </span>
            <span className="text-xs text-dim">
              ~<span className="num">{exercises.length * 8}</span> min
            </span>
          </div>
          <Button variant="primary" full onClick={onStart}>
            Start session <ChevronRight size={14} strokeWidth={2} style={{ marginLeft: 4 }} />
          </Button>
        </div>
      </div>
    </div>
  )
}
