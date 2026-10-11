# 1. Sign up at https://capgo.app
# 2. Initialize the project (run inside app/)
npx @capgo/cli init
#    → appId: com.strinteg.emergencybridge
#    → registers the API key with the native project
# 3. Build the web bundle
npm run build
# 4. Upload
npx @capgo/cli bundle upload
```

**Pros**
- Zero infra to maintain; CDN delivery out of the box.
- Built-in channels (e.g. `dev` / `staging` / `production`) and staged rollouts by percentage.
- Automatic rollback if `notifyAppReady()` isn't called.

**Cons**
- Vendor dependency (Capgo cloud availability, API keys).
- Pricing scales with monthly active devices — **check current pricing at <https://capgo.app/pricing/>** before committing. Free tier is fine for pilots; larger field deployments may hit paid tiers quickly.

## 3. Option B — Self-hosted

You control the manifest and the zip; the plugin only needs an HTTPS URL that returns the JSON below.

### Manifest format

The plugin expects JSON with at least `version`, `url`, and `checksum`:

```json
{
  "version": "1.4.2",
  "url": "https://ota.example.com/bundles/emergencybridge-1.4.2.zip",
  "checksum": "3f2b9c1e8a4d7f60b5e2c9a1d4f8b7e6c3a2d9f4b1e8c7a6d5f4b3e2c1a9d8f7"
}
```

Notes:
- `version` is a plain string — pick semantic versions and compare client-side.
- `checksum` is SHA-256 of the zip (hex, lowercase).
- The zip must contain the **contents of `dist/`** at its root (i.e. `index.html` at the top level, not nested inside a `dist/` folder).

### Build the bundle

```bash
npm run build
cd dist && zip -r ../emergencybridge-$(node -p "require('../package.json').version").zip . && cd ..
```

### Host it

Any HTTPS static host works — S3 + CloudFront, Render Static Site, Netlify, Cloudflare Pages, or a plain nginx box. Then set:

```
VITE_OTA_UPDATE_URL=https://ota.example.com/manifest.json
```

and rebuild + resync the native project so the URL is baked into the shell.

### Minimal Node/Express server with version gating

```js
// server.js — serves a manifest that only offers an update if the
// client's current version is older than the latest published bundle.
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

const BUNDLE_DIR = path.join(__dirname, 'bundles');
const LATEST = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, 'latest.json'), 'utf8'));
// latest.json shape: { "version": "1.4.2", "file": "emergencybridge-1.4.2.zip", "checksum": "..." }

// naive semver compare — swap for `semver` if you want pre-release handling
function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

app.get('/manifest.json', (req, res) => {
  const current = String(req.query.version || '0.0.0');
  if (!isNewer(LATEST.version, current)) {
    // Client is up to date — return its own version so the plugin skips download.
    return res.json({ version: current, url: '', checksum: '' });
  }
  res.json({
    version: LATEST.version,
    url: `https://ota.example.com/bundles/${LATEST.file}`,
    checksum: LATEST.checksum
  });
});

app.use('/bundles', express.static(BUNDLE_DIR, { immutable: true, maxAge: '1y' }));
app.listen(8080, () => console.log('OTA server on :8080'));
```

Point `VITE_OTA_UPDATE_URL` at `https://ota.example.com/manifest.json`. The plugin appends `?version=<current>` (or you can add it explicitly in your config) so the server can gate.

## 4. Release workflow

1. Bump the version in `package.json` (`npm version patch|minor|major --no-git-tag-version`).
2. `npm run build`
3. Zip `dist/` contents and compute the SHA-256 checksum.
4. Upload the zip + update `manifest.json` (self-hosted) **or** `npx @capgo/cli bundle upload` (Capgo).
5. **Staged rollout:** for self-hosted, serve the new manifest to a small percentage of clients first (e.g. by device ID hash or a `?channel=canary` flag). For Capgo, use the dashboard's percentage rollout. Watch crash reports for 24–48h before going 100%.

## 5. Gotchas

- **Web-only.** OTA replaces HTML/JS/CSS/assets. Adding or updating a **native plugin**, changing `AndroidManifest.xml`, bumping the Capacitor version, or altering permissions all require a new APK submission. Plan native changes in a separate release train.
- **`notifyAppReady()` is mandatory.** If `main.tsx` doesn't call it within the plugin's timeout (default ~10s), the next launch rolls back to the previous bundle. Keep the call at the very top of your entry file, before async work.
- **Channels.** Keep `dev` / `staging` / `production` separate. Never point a production APK at a staging manifest, and never publish a bundle to production that hasn't passed through staging on a real device.
- **Rollback.** Both paths roll back by re-publishing an older bundle with a *higher* version string than the bad one (e.g. bad `1.4.2` → republish good `1.4.1` code as `1.4.3`). The plugin only compares versions, not contents, so you can't "downgrade" by version number alone.
- **Checksums matter.** A corrupted or truncated zip downloaded over a flaky field connection will fail verification and the plugin will skip it — good. Don't disable checksum validation to "fix" failed updates; the failure is usually a hosting/CDN issue.
