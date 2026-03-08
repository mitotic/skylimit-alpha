# Admin Guide

This guide covers deployment of Skylimit and setup of the Skyspeed test server for development.


## Deployment

### GitHub Pages (Primary)

Skylimit is deployed to [skylimit.dev](https://skylimit.dev) via the [skylimit-alpha](https://github.com/mitotic/skylimit-alpha) GitHub repository using GitHub Pages with a custom domain.

The deployment workflow:

1. Develop and test in the Websky repository
2. Run the copy script (with user confirmation):
   ```bash
   cd Websky
   ./copy-to-skylimit-alpha.sh
   ```
   This copies all source files to `skylimit-alpha/`, excluding `.git`, root-level `.md` files, `node_modules`, `dist`, credentials, and the `.claude` directory. The `docs/` directory *is* copied.
3. In the `skylimit-alpha` directory:
   ```bash
   cd ../skylimit-alpha
   npm install
   npm run build
   ```
4. Commit and push to GitHub to deploy.

### Other Static Hosting

Since Skylimit builds to static files, it can be deployed to any static hosting provider:

**Netlify**:
- Connect your repository
- Build command: `npm run build`
- Publish directory: `dist`

**Vercel**:
- Connect your repository
- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`

**Cloudflare Pages**:
- Connect your repository
- Build command: `npm run build`
- Build output directory: `dist`

**Any static hosting**: Upload the contents of `dist/` after building.

### Build Configuration

- Dev server port: **5181** (configured in `vite.config.ts`). To use a different port (e.g., when testing multiple forks on separate origins): `npm run dev -- --port 5182`
- Build output: `dist/`
- No environment variables are required for production (API endpoint defaults to `bsky.social`)
- HTTPS is recommended for production (session tokens are stored in browser storage)
- Source maps are disabled in production builds


## Skyspeed Test Server

### Overview

Skyspeed is a lightweight AT Protocol test server that generates deterministic feeds from a seed. It allows developing and testing Bluesky clients without connecting to the live network.

Key features:

- **Deterministic posts**: Same seed always produces the same users and content
- **Clock acceleration**: A clock factor of 60 means one real second equals one simulated minute
- **Time shifting**: Jump the clock forward to skip idle periods
- **Scripted posts**: Define specific posts with exact text at precise times
- **Admin panel**: Web UI for server control and script management

Skyspeed runs two servers:

- **Admin server**: Port 3200 (web UI)
- **XRPC server**: Port 3210 (AT Protocol endpoints)

### Quick Start

```bash
cd Skyspeed
npm install
npm run admin
```

This starts the admin panel at `http://localhost:3200`. The XRPC server starts on port 3210 when you load a script or start the server from the admin UI.

To run with a script file directly:

```bash
npm run admin -- --script=myscript.txt
```

### Connecting Websky to Skyspeed

**Method 1: URL parameter** (recommended)

Navigate to:
```
http://localhost:5181/?server=localhost:3210
```

A confirmation dialog will appear and the curation cache will be reset. This stores the server configuration in `localStorage` so it persists across page loads.

To switch back to the default Bluesky server:
```
http://localhost:5181/?server=
```

**Method 2: Environment variable** (development only)

```bash
VITE_BSKY_SERVICE=http://localhost:3210 npm run dev
```

### Login Credentials

When connected to Skyspeed, any credentials are accepted. The server always logs in as `testuser.skyspeed.local`.

### Scripting

Skyspeed scripts define server configuration and timed post sequences. See [Skyspeed/docs/SCRIPTING.md](../../Skyspeed/docs/SCRIPTING.md) for the full scripting reference.

Key initialization commands:

| Command | Default | Purpose |
|---------|---------|---------|
| `CLOCK FACTOR <n>` | 1 | Clock acceleration (60 = 1 real sec = 1 sim min) |
| `CONNECT HH:MM` | &mdash; | Set simulated time upon client connection |
| `POSTS PER DAY <n>` | 1800 | Total followee posts per simulated day |
| `RANDOM SEED <string>` | skyspeed | Seed for deterministic post generation |

Key timed commands:

| Command | Purpose |
|---------|---------|
| `HH:MM POST BY @handle` | Create a post at the specified time |
| `HH:MM REPLY BY @handle TO HH:MM` | Create a reply to a post |
| `HH:MM REPOST BY @handle OF HH:MM` | Create a repost |
| `HH:MM TIME SHIFT +HH:MM` | Jump the clock forward |
| `HH:MM PAUSE` | Pause script execution |

### Testing Curation with Skyspeed

Some tips for effective curation testing:

- **`CLOCK FACTOR 60`**: Simulates one hour per minute, allowing you to observe curation behavior over many hours quickly.
- **`CONNECT 09:00`**: Sets a specific starting time for reproducible tests.
- **Followee numbering**: Generated followees are named `followee1` through `followeeN`. The number roughly indicates their posting rate (e.g., `followee3` posts about 3 times per day). Low-numbered followees will likely have all posts shown; high-numbered ones will be filtered.
- **`TIME SHIFT`**: Simulates idle periods without waiting. Useful for testing how curation handles gaps in data.

### URL Parameters for Automation

Websky supports URL parameters for automated testing with Skyspeed:

```
http://localhost:5181/?server=localhost:3210&username=test&password=&viewsperday=300&debug=1
```

| Parameter | Purpose |
|-----------|---------|
| `server` | Skyspeed host:port |
| `username` | Auto-login username |
| `password` | Auto-login password (empty for Skyspeed) |
| `viewsperday` | Set views per day setting |
| `debug` | Enable (1) or disable (0) debug mode |
| `reset` | Set to 1 to clear all curation data and log out |
| `clobber` | Set to 1 to delete all site data (nuclear option) |


## Troubleshooting

- **Login fails**: Verify you are using an app password, not your account password. App passwords can be created at [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords).

- **Feed is empty after connecting to Skyspeed**: Check that the XRPC server is running on port 3210. Look at the Skyspeed admin panel for server status.

- **Stale code after update**: Hard refresh the browser (Ctrl+Shift+R on Windows/Linux, Cmd+Shift+R on Mac). Clear the browser cache if the issue persists.

- **Corrupted data**: Use "Reset all" in Settings to clear all caches and start fresh (this will log you out).

- **Database version error**: If the app fails to load with an IndexedDB `VersionError` (e.g., after testing a different fork on the same origin), add `?clobber=1` to the URL to delete all site data and start fresh.

- **Curation not working**: Check that curation is not suspended in Settings. If statistics aren't appearing, wait a few minutes for data to accumulate. Check the browser console for error messages.

- **Rate limiting**: If you see rate limit indicators, wait a few minutes. The API implements exponential backoff with automatic retries.
