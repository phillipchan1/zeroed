import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Walk dist/ and list every emitted asset as a root-relative URL, so the
// service worker can precache the exact (hashed) files this build produced.
function listDistAssets(distDir: string): string[] {
  const urls: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      const rel = relative(distDir, full).split('\\').join('/')
      if (rel === 'sw.js') continue // never precache the worker itself
      urls.push('/' + rel)
    }
  }
  walk(distDir)
  return urls
}

// Injects the build's asset manifest + a content version into the prebuilt
// public/sw.js (copied verbatim into dist by Vite). Offline-first precaching
// only works if the worker knows the hashed filenames this build emitted.
function offlineServiceWorker(): Plugin {
  let outDir = 'dist'
  return {
    name: 'zeroed-offline-sw',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const swPath = join(outDir, 'sw.js')
      let source: string
      try {
        source = readFileSync(swPath, 'utf8')
      } catch {
        return // no sw.js in this build — nothing to wire up
      }
      // Precache the built JS/CSS/icons. Skip source maps and the manifest
      // (already in the shell list) to keep the install lean.
      const assets = listDistAssets(outDir).filter(
        (u) => !u.endsWith('.map') && u !== '/manifest.webmanifest',
      )
      const version = String(Date.now())
      const injected = source
        .replaceAll('__SW_VERSION__', version)
        .replace(
          'self.__PRECACHE_MANIFEST__ || []',
          `${JSON.stringify(assets)} /* injected at build */`,
        )
      writeFileSync(swPath, injected)
    },
  }
}

export default defineConfig({
  plugins: [react(), offlineServiceWorker()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
})
