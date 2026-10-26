# iOS releases & TestFlight

How the native iPhone app is built, signed, and uploaded to **Internal
TestFlight**. Same React SPA and `dist/` as the PWA — Capacitor wraps it in a
WKWebView.

Mirrors [phillipchan1/nuvo](https://github.com/phillipchan1/nuvo)
`docs/ios-releases.md` and `.github/workflows/ios-release.yml`, adapted for
Capacitor (Nuvo uses Tauri). **No App Store review. No web prod deploy.**

---

## Delivery

| Channel | Trigger | Update on your phone |
|---|---|---|
| **PWA** (Vercel) | merge → `master` | Service worker |
| **iOS TestFlight** (`ios-release.yml`) | merge → `master`, or **Run workflow** | TestFlight app (enable **Automatic Updates**) |

Same as Nuvo: every push to `master` uploads an Internal TestFlight build.
**Run workflow** is still there for a re-run or a PR-branch smoke test. The
job **skips green** (does not fail red) until the Apple secrets exist.

---

## Architecture

```
src/                     React SPA (same as the PWA)
capacitor.config.ts      appId app.zeroed.app
ios/                     Committed Capacitor Xcode project (Pods / public gitignored)
.github/workflows/
  ios-release.yml        Build signed IPA → Internal TestFlight (master + dispatch)
  checks.yml             typecheck + engine checks + iOS project structure
```

Nuvo regenerates `src-tauri/gen/apple/` with `tauri ios init` on every CI run.
Capacitor's `ios/` project is source: CI runs `npm run build && npx cap sync ios`,
then `xcodebuild archive` / `-exportArchive` / `xcrun altool --upload-app` —
the same three tools Nuvo's `tauri ios build` + upload step wrap.

Auth is email OTP (code), not Google, so Sign in with Apple is **not** required.

---

## Bundle ID

**`app.zeroed.app`**

Nuvo iOS is `day.nuvo.app` (`{surface}.{brand}.app`). Zeroed has no separate
App Store product name, so the surface is `app`. Must match
`capacitor.config.ts` → `appId` and `PRODUCT_BUNDLE_IDENTIFIER` in
`ios/App/App.xcodeproj/project.pbxproj`.

---

## What CI does

On every push to `master` (and **Run workflow**):

1. Checks that the Apple + signing secrets exist. If any are missing, the
   upload job is **skipped** and the workflow stays green, with a notice
   listing what is absent.
2. Stamps version `<major>.<minor>.<commit_count>` — patch is
   `git rev-list --count HEAD` (same scheme as Nuvo).
3. Checks that build number against App Store Connect
   (`scripts/appstore-next-build-number.mjs`) and bumps past it if this
   exact version was already uploaded (manual re-run of the same commit).
4. `npm ci` → `vite build` → `npx cap sync ios`.
   `VITE_API_BASE_URL` comes from a **repo variable**. When it is empty,
   the build bakes `VITE_SUPABASE_*` (today's path). When it is set to the
   Worker URL at cutover, those Supabase values are **not** baked. See
   [`cloudflare-cutover.md`](./cloudflare-cutover.md) § iOS TestFlight at cutover.
5. After the web build, write the App Store Connect `.p8` under
   `$RUNNER_TEMP/zeroed-asc.p8` with `umask 077` (raw PEM or base64). Copy
   to `~/.appstoreconnect/private_keys/AuthKey_<id>.p8` for `altool`.
6. Resolve the build number against App Store Connect, then
   `xcodebuild archive` + `-exportArchive` with `method=app-store-connect`,
   `CODE_SIGN_STYLE=Automatic`, `-allowProvisioningUpdates`, and the API
   key (`-authenticationKeyPath` / `-authenticationKeyID` /
   `-authenticationKeyIssuerID`). Cloud-managed distribution signing —
   no `.p12`, no hand-made provisioning profile.
7. `xcrun altool --upload-app` → App Store Connect → **Internal** TestFlight.
   The workflow does not submit for App Review and does not add external testers.
8. An `always()` step deletes `${{ runner.temp }}/zeroed-asc.p8` and
   `~/.appstoreconnect/private_keys/AuthKey_*.p8` — fixed path/glob, not
   env set by an earlier step.

~15–20 min on `macos-latest`. Concurrency group `ios-testflight` with
`cancel-in-progress: false`, so a newer push queues instead of killing an
upload mid-flight.

---

## One-time setup (Phil)

Do these once. After that, every push to `master` (or **Run workflow**)
uploads an Internal TestFlight build.

### 1 · Apple Developer Program

Already enrolled for Nuvo. Same team.

### 2 · Register the App ID

[Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources)
→ **Identifiers** → **+** → App IDs → App → explicit bundle ID
**`app.zeroed.app`**. Description `Zeroed`. No extra capabilities for v1
(HTTPS only; email OTP).

### 3 · App Store Connect app record

1. [App Store Connect](https://appstoreconnect.apple.com) → **Apps** → **+**.
2. **New App** → iOS → name **Zeroed** → bundle ID **`app.zeroed.app`**.
3. SKU: anything (e.g. `zeroed-ios`). User access: Full Access for yourself.

Do **not** Submit for Review.

### 4 · App Store Connect API key

Create an App Store Connect API key (Users and Access → Integrations →
App Store Connect API) with **Admin** or **App Manager** so
`-allowProvisioningUpdates` can create the cloud-managed distribution
profile and certificate. Download the `.p8` once.

| Secret | Required | Value |
|---|---|---|
| `ASC_API_KEY_ID` | yes | App Store Connect API Key ID |
| `ASC_API_ISSUER_ID` | yes | App Store Connect Issuer ID |
| `ASC_API_KEY_P8` | yes | Raw PEM of the `.p8`, **or** base64 of that file |
| `APPLE_TEAM_ID` | yes | 10-char Team ID (Membership page) — passed as `DEVELOPMENT_TEAM` |

`base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy` if you prefer to store it encoded.
The workflow accepts either form, writes the PEM to
`$RUNNER_TEMP/zeroed-asc.p8` with `umask 077` (after `cap sync`, just
before `xcodebuild`), and deletes that path plus
`~/.appstoreconnect/private_keys/AuthKey_*.p8` in an `always()` step.

No `.p12`. No hand-made `.mobileprovision`. Xcode's automatic signing
creates the App Store Connect distribution profile against `app.zeroed.app`.

### 5 · NEW secrets / variable (Zeroed-only)

| Name | Kind | Why it's new |
|---|---|---|
| `VITE_SUPABASE_URL` | secret | Zeroed's Supabase project (same value as Vercel Production). Used only while `VITE_API_BASE_URL` is empty. |
| `VITE_SUPABASE_ANON_KEY` | secret | Zeroed's anon key (same value as Vercel Production). Used only while `VITE_API_BASE_URL` is empty. |
| `VITE_API_BASE_URL` | **variable** | Leave empty until Cloudflare cutover. Then set to `https://<worker>/api`. See [`cloudflare-cutover.md`](./cloudflare-cutover.md). |

Settings → Secrets and variables → Actions on **phillipchan1/zeroed**.
This repo does not change secrets for you. Until they exist, the
TestFlight job **skips green** instead of failing red.

### 6 · TestFlight internal testing

1. After the first CI upload succeeds, the build appears in
   App Store Connect → **TestFlight** (~5–15 min processing).
2. **Internal Testing** → create group → add yourself.
3. Install **TestFlight** on the iPhone → accept the invite → install Zeroed.
4. TestFlight → **Settings** → enable **Automatic Updates**.

Internal testers get builds without App Review. Skip external testers / Beta
App Review for personal dogfooding.

---

## Trigger the first build

1. Finish steps 2–5 above (App ID, ASC app record, API key secrets).
2. Merge to `master` (automatic) **or** GitHub → **phillipchan1/zeroed** →
   **Actions** → **iOS TestFlight** → **Run workflow**. Dispatch from this
   PR's branch to smoke-test the pipeline before merge.
3. Watch the `testflight` job. Upload prints
   `Uploading … (v<version>, build <n>) to Internal TestFlight`.
   If secrets are still missing, only **Check TestFlight secrets** runs and
   the upload job is skipped — the workflow stays green.
4. App Store Connect → TestFlight → wait for processing → Internal Testing.

Re-running the same commit is safe: `appstore-next-build-number.mjs` bumps
`CFBundleVersion` past whatever is already on file for that marketing version.

---

## Local (optional, on a Mac)

```bash
npm ci
npm run build
npx cap sync ios
npx cap open ios          # Xcode; set Team to your Apple Team ID
```

Signing in Xcode is only for a local device run. CI does not use your Mac.

Regenerate the 1024 App Store icon + dark splash after a brand change:

```bash
pip3 install Pillow
python3 scripts/gen-icons.py
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Workflow skips (green) | Missing secrets listed in the **Check TestFlight secrets** notice |
| Workflow fails at signing | Check `ASC_API_KEY_*`, `APPLE_TEAM_ID`, and that the key is Admin / App Manager |
| `No profiles for app.zeroed.app` | Register the App ID, then re-run — automatic signing creates the profile |
| Upload rejected (SDK too old) | Bump `runs-on:` to a newer `macos-*` in `ios-release.yml` |
| Build not in TestFlight | App Store Connect → Activity; check email for compliance questions |
| Encryption export questionnaire | `ITSAppUsesNonExemptEncryption=false` is set in `ios/App/App/Info.plist` |
| Icon rejected (90717 alpha channel) | Re-run `python3 scripts/gen-icons.py` — it writes RGB, no alpha |
| `cap sync` on Linux skips pods | Expected. CI is `macos-latest` and runs CocoaPods |

---

## Rotating credentials

New ASC API key → update `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, and
`ASC_API_KEY_P8`, then revoke the old key. Cloud-managed distribution
certs and profiles are renewed by Apple; nothing in this repo stores them.
