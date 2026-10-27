// Per-device memory for logging outside the plan: the activities this athlete
// logs, newest first, so Tuesday's BJJ is the first chip on Thursday.
//
// A convenience only, like addMemory. localStorage, every access guarded: a
// private window or a cleared site just means the sheet opens on suggestions.
// The record itself is the session's exercises_snapshot.

import { rememberActivity } from '../engine/outsidePlan'

const KEY = 'zeroed:outside-plan-recent'

export function recentActivities(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function saveActivity(activity: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rememberActivity(recentActivities(), activity)))
  } catch { /* non-fatal */ }
}
