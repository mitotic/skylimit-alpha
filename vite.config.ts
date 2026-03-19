import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { exec, spawn } from 'child_process'
import crypto from 'crypto'
import os from 'os'

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

// Accept bug reports from the client and spawn Claude Code to process them.
// Dev-only: configureServer hook is not called during production builds.
function bugReportPlugin(): Plugin {
  const projectDir = __dirname

  function detectMode(origin: string | undefined): 'terminal' | 'background' | 'reject' {
    if (!origin) return 'reject'
    // Codespaces forwarded ports use *.app.github.dev
    if (origin.includes('.app.github.dev')) return 'background'
    try {
      const url = new URL(origin)
      const port = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80)
      return port >= 1024 ? 'terminal' : 'reject'
    } catch {
      return 'reject'
    }
  }

  return {
    name: 'bug-report',
    configureServer(server) {
      server.middlewares.use('/api/bug-report', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', () => {
          try {
            const { report, image, imageName } = JSON.parse(body)
            if (!report || typeof report !== 'string') {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Missing report field' }))
              return
            }

            const origin = req.headers.origin || req.headers.referer || ''
            const mode = detectMode(origin as string)

            if (mode === 'reject') {
              res.statusCode = 403
              res.end(JSON.stringify({ error: 'Bug report submission not available in this environment' }))
              return
            }

            const id = crypto.randomUUID().slice(0, 8)
            const prefix = 'Websky bug report (with console logs). Read PrePrompt.md before making code changes.\n\n'

            // Save attached image if provided
            let imageNote = ''
            if (image && typeof image === 'string' && image.startsWith('data:image/')) {
              const ext = (imageName || 'screenshot.png').split('.').pop() || 'png'
              const imgFile = path.join(os.tmpdir(), `websky-bug-${id}.${ext}`)
              const base64Data = image.replace(/^data:image\/\w+;base64,/, '')
              fs.writeFileSync(imgFile, Buffer.from(base64Data, 'base64'))
              imageNote = `\n\nIMPORTANT: A screenshot is attached. Read the image file at ${imgFile} now before responding.`
              // Clean up image after delay
              setTimeout(() => { try { fs.unlinkSync(imgFile) } catch {} }, 120000)
            }

            const fullReport = prefix + report + imageNote
            const tmpFile = path.join(os.tmpdir(), `websky-bug-${id}.txt`)
            fs.writeFileSync(tmpFile, fullReport)

            if (mode === 'terminal') {
              // Open a new Terminal.app window with an interactive Claude Code session
              const escapedDir = projectDir.replace(/'/g, "'\\''")
              const escapedTmp = tmpFile.replace(/'/g, "'\\''")
              const script = `tell application "Terminal" to do script "cd '${escapedDir}' && cat '${escapedTmp}' | claude"`
              exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
                if (err) console.error('Failed to open Terminal:', err.message)
              })
              // Clean up temp file after delay (claude reads it quickly via cat pipe)
              setTimeout(() => { try { fs.unlinkSync(tmpFile) } catch {} }, 30000)

              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, mode: 'terminal' }))

            } else {
              // Background mode: spawn claude -p and save response to file
              const responsesDir = path.join(projectDir, 'bug-report-responses')
              if (!fs.existsSync(responsesDir)) fs.mkdirSync(responsesDir, { recursive: true })
              const responseFile = `bug-report-responses/response-${id}.md`
              const responseFullPath = path.join(projectDir, responseFile)

              console.log(`\n[bug-report] Bug report received, Claude is processing...`)
              console.log(`[bug-report] Response will be saved to ${responseFile}`)

              const child = spawn('claude', ['-p'], {
                cwd: projectDir,
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: true,
              })
              child.stdin.write(fullReport)
              child.stdin.end()

              let stdout = ''
              let stderr = ''
              child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
              child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
              child.on('close', (code) => {
                const output = stdout || stderr || '(no output)'
                fs.writeFileSync(responseFullPath, output)
                console.log(`[bug-report] Claude response saved to ${responseFile} (exit code: ${code})`)
                // Clean up temp file
                try { fs.unlinkSync(tmpFile) } catch {}
              })
              child.unref()

              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, mode: 'background', responseFile }))
            }
          } catch (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: 'Internal server error' }))
          }
        })
      })
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), versionJsonPlugin(), bugReportPlugin()],
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




