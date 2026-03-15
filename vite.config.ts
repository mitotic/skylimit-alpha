import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Generate version.json from package.json version at build time
function versionJsonPlugin(): Plugin {
  return {
    name: 'version-json',
    writeBundle(options) {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))
      const outDir = options.dir || path.resolve(__dirname, 'dist')
      fs.writeFileSync(path.join(outDir, 'version.json'), JSON.stringify({ version: pkg.version }))
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), versionJsonPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5181,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})




