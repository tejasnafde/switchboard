import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    // `@agentclientprotocol/sdk` is ESM-only ("type": "module"). The main
    // bundle is CJS, so externalizing it makes packaged builds throw
    // ERR_REQUIRE_ESM at runtime. Bundle it instead.
    plugins: [externalizeDepsPlugin({ exclude: ['@agentclientprotocol/sdk'] })],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
  },
})
