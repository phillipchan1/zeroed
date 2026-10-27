// The interval timer's voice: the 3-2-1, the go, halfway, the rest, the finish.
//
// What it sounds like lives in engine/cueSound.ts — the zero-beat motif,
// designed once and rendered sample by sample. This module only decides WHERE
// it plays:
//
//   · in the iPhone app, through the native ZeroedCues plugin, which plays the
//     same design (bundled WAVs rendered from it) through Silent Mode and dips
//     the athlete's music under each cue instead of stopping it. The web view
//     can't: WKWebView audio is muted by the silent switch, and the web's way
//     around that pauses the music;
//   · everywhere else, through Web Audio, the design rendered into buffers on
//     ONE context, created and unlocked by the tap that starts the block — iOS
//     Safari starts a context made outside a gesture suspended, with no way to
//     wake it.
//
// Haptics ride every cue too, so a muted phone or a loud gym still gets it.

import { Capacitor, registerPlugin } from '@capacitor/core'
import { tick, record, alert, success } from './haptics'
import { CUE_NAMES, renderCue, type CueName } from '../engine/cueSound'

const SOUND_KEY = 'zeroed.interval_sound'

type WindowWithAudio = Window & { webkitAudioContext?: typeof AudioContext }

interface ZeroedCuesPlugin {
  preload(options: { names: string[] }): Promise<void>
  play(options: { name: string }): Promise<void>
  release(): Promise<void>
}

const ZeroedCues = registerPlugin<ZeroedCuesPlugin>('ZeroedCues')

function nativeCues(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('ZeroedCues')
  } catch {
    return false
  }
}

let ctx: AudioContext | null = null
const buffers = new Map<CueName, AudioBuffer>()

/** On by default: an interval timer you have to watch is a stopwatch. */
export function intervalSoundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setIntervalSound(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off')
  } catch { /* non-persistent session */ }
}

// Render the design into buffers at the context's own rate — a few ms of
// arithmetic, deferred so it never sits inside the tap.
function renderBuffers(c: AudioContext): void {
  setTimeout(() => {
    for (const name of CUE_NAMES) {
      if (buffers.has(name) || ctx !== c) continue
      try {
        const samples = renderCue(name, c.sampleRate)
        const buf = c.createBuffer(1, samples.length, c.sampleRate)
        buf.getChannelData(0).set(samples)
        buffers.set(name, buf)
      } catch { /* this cue stays silent; the haptic still lands */ }
    }
  }, 0)
}

/**
 * Get the cues ready. Call it synchronously inside a tap handler — that is
 * what unlocks Web Audio on iOS for the rest of the block. Natively it loads
 * the players so the first cue isn't late.
 */
export function primeCueAudio(): void {
  if (nativeCues()) {
    void ZeroedCues.preload({ names: [...CUE_NAMES] }).catch(() => {})
  }
  try {
    const Ctor = window.AudioContext ?? (window as WindowWithAudio).webkitAudioContext
    if (!Ctor) return
    if (!ctx || ctx.state === 'closed') {
      ctx = new Ctor()
      buffers.clear()
    }
    void ctx.resume().catch(() => {})
    // A one-sample silent buffer, played inside the gesture: older WebKit only
    // counts the context as unlocked once something has actually played on it.
    const silent = ctx.createBuffer(1, 1, 22050)
    const src = ctx.createBufferSource()
    src.buffer = silent
    src.connect(ctx.destination)
    src.start(0)
    renderBuffers(ctx)
  } catch { /* no Web Audio here — the native player or the haptics carry it */ }
}

/** Let the hardware go once the block is over; a held session can duck music. */
export function releaseCueAudio(): void {
  if (nativeCues()) void ZeroedCues.release().catch(() => {})
  const c = ctx
  ctx = null
  buffers.clear()
  if (c) void c.close().catch(() => {})
}

function playWeb(name: CueName): void {
  try {
    if (!ctx || ctx.state === 'closed') primeCueAudio()
    const c = ctx
    if (!c) return
    if (c.state === 'suspended') void c.resume().catch(() => {})
    let buf = buffers.get(name)
    if (!buf) {
      const samples = renderCue(name, c.sampleRate)
      buf = c.createBuffer(1, samples.length, c.sampleRate)
      buf.getChannelData(0).set(samples)
      buffers.set(name, buf)
    }
    const src = c.createBufferSource()
    src.buffer = buf
    src.connect(c.destination)
    src.start()
  } catch { /* audio refused — the haptic still lands */ }
}

function play(name: CueName): void {
  if (!intervalSoundOn()) return
  if (nativeCues()) {
    // The native player failing (a missing file, a session it couldn't get)
    // falls back to the web — silent in Silent Mode, but never worse than that.
    void ZeroedCues.play({ name }).catch(() => playWeb(name))
    return
  }
  playWeb(name)
}

/** 3 · 2 · 1 — ticks climbing toward the note the go will lock onto. */
export function cueCount(n: number): void {
  const k = Math.max(1, Math.min(3, Math.round(n)))
  play(`count-${k}` as CueName)
  tick()
}

/** Work: the zero-beat lock. The last round locks a chord — the final push. */
export function cueGo(last = false): void {
  play(last ? 'go-last' : 'go')
  record()
}

/** Halfway through a long round: two light pings. */
export function cueHalf(): void {
  play('half')
  tick()
}

/** Rest: the lock, released — a unison coming apart and falling away. */
export function cueRest(): void {
  play('rest')
  alert()
}

/** The block is done: the session chord, every note zero-beating in. */
export function cueDone(): void {
  play('done')
  success()
}
