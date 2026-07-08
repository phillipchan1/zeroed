import { useEffect } from 'react'

// iOS shows "Undo Typing" when the device is shaken while a text input holds
// undo history. The only reliable prevention is to keep inputs blurred (and
// therefore their undo stacks empty) when the user isn't actively typing.
//
// Strategy:
//  1. Primary — auto-blur after 2 s of no input. By the time the user could
//     shake/drop the phone, the field is already blurred and iOS has nothing
//     to undo. Works with zero permissions.
//  2. Fallback — devicemotion shake detection for the immediate-drop case.
//     Requires the iOS 13+ motion permission granted on first touch.

const AUTO_BLUR_IDLE_MS = 2000
const SHAKE_THRESHOLD = 20  // m/s²
const SHAKE_DEBOUNCE_MS = 800

export function useDisableShakeToUndo() {
  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout>
    let lastShakeTime = 0

    function blurActiveInput() {
      const el = document.activeElement
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) {
        el.blur()
      }
    }

    // 1. Auto-blur on typing idle
    function onInput() {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(blurActiveInput, AUTO_BLUR_IDLE_MS)
    }
    document.addEventListener('input', onInput, { passive: true, capture: true })

    // 2. Shake detection fallback
    function handleMotion(e: DeviceMotionEvent) {
      const acc = e.acceleration
      if (!acc || (acc.x == null && acc.y == null && acc.z == null)) return
      const magnitude = Math.sqrt(
        Math.pow(acc.x ?? 0, 2) +
        Math.pow(acc.y ?? 0, 2) +
        Math.pow(acc.z ?? 0, 2),
      )
      const now = Date.now()
      if (magnitude > SHAKE_THRESHOLD && now - lastShakeTime > SHAKE_DEBOUNCE_MS) {
        lastShakeTime = now
        blurActiveInput()
      }
    }

    function startMotionListener() {
      window.addEventListener('devicemotion', handleMotion, { passive: true })
    }

    if (typeof DeviceMotionEvent !== 'undefined') {
      const DME = DeviceMotionEvent as typeof DeviceMotionEvent & {
        requestPermission?: () => Promise<string>
      }
      if (typeof DME.requestPermission === 'function') {
        document.addEventListener(
          'touchstart',
          () => {
            DME.requestPermission!()
              .then(s => { if (s === 'granted') startMotionListener() })
              .catch(() => {})
          },
          { once: true, passive: true },
        )
      } else {
        startMotionListener()
      }
    }

    return () => {
      clearTimeout(idleTimer)
      document.removeEventListener('input', onInput, { capture: true })
      window.removeEventListener('devicemotion', handleMotion)
    }
  }, [])
}
