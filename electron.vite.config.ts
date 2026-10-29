import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // index.ts picks the role: the app (app.ts) or the floating widget's XWayland host (widget/host.ts). The
        // agent worker runs in its own utility process (src/main/agent/worker-host.ts).
        input: {
          index: resolve('src/main/index.ts'),
          app: resolve('src/main/app.ts'),
          'widget-host': resolve('src/main/widget/host.ts'),
          agent: resolve('src/main/agent/worker/entry.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  renderer: {
    resolve: { alias: { ...shared, '@renderer': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          widget: resolve('src/renderer/widget.html')
        }
      }
    }
  }
})
