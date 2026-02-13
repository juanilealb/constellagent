import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

const sharedPath = resolve(__dirname, 'src/shared').replace(/\\/g, '/')
const mainAlias = [
  { find: /^@shared\/(.*)$/, replacement: `${sharedPath}/$1` },
  { find: '@shared', replacement: sharedPath },
]
const rendererPlatformPath = resolve(__dirname, 'src/shared/platform.renderer.ts').replace(/\\/g, '/')
const rendererAlias = [
  { find: '@shared/platform', replacement: rendererPlatformPath },
  { find: /^@shared\/(.*)$/, replacement: `${sharedPath}/$1` },
  { find: '@shared', replacement: sharedPath },
]

export default defineConfig({
  main: {
    resolve: {
      alias: mainAlias
    }
  },
  preload: {
    resolve: {
      alias: mainAlias
    }
  },
  renderer: {
    resolve: {
      alias: rendererAlias
    }
  }
})
