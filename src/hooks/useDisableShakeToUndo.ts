import { useEffect } from 'react'

// iOS shows "Undo Typing" when the device is shaken while a text input is focused.
// We prevent this by detecting the shake via devicemotion and blurring the active
// input before iOS can show the dialog.
const SHAKE_THRESHOLD = 20 // m/s² — well above casual movement, well below drop impact
const DEBOUNCE_MS = 800

export function useDisableShakeToUndo() {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') return

    let lastShakeTime = 0

    function handleMotion(e: DeviceMotionEvent) {
      const acc = e.acceleration
      if (!acc || (acc.x == null && acc.y == null && acc.z == null)) return

      const magnitude = Math.sqrt(
        Math.pow(acc.x ?? 0, 2) +
        Math.pow(acc.y ?? 0, 2) +
        Math.pow(acc.z ?? 0, 2),
      )

      const now = Date.now()
      if (magnitude > SHAKE_THRESHOLD && now - lastShakeTime > DEBOUNCE_MS) {
        lastShakeTime = now
        const active = document.activeElement
        if (
          active instanceof HTMLElement &&
          (active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable)
        ) {
          active.blur()
        }
      }
    }

    function startListening() {
      window.addEventListener('devicemotion', handleMotion, { passive: true })
    }

    // iOS 13+ requires an explicit permission request inside a user gesture.
    // We piggyback on the first touchstart so we don't need a dedicated prompt.
    if (typeof (DeviceMotionEvent as { requestPermission?: () => Promise<string> }).requestPermission === 'function') {
      const requestOnTouch = () => {
        ;(DeviceMotionEvent as { requestPermission: () => Promise<string> })
          .requestPermission()
          .then(state => { if (state === 'granted') startListening() })
          .catch(() => {})
      }
      document.addEventListener('touchstart', requestOnTouch, { once: true, passive: true })
    } else {
      startListening()
    }

    return () => {
      window.removeEventListener('devicemotion', handleMotion)
    }
  }, [])
}
