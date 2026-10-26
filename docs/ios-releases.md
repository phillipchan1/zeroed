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
5. `xcodebuild archive` + `-exportArchive` with
   `method=app-store-connect` and **manual** signing
   (`IOS_CERTIFICATE` + `IOS_MOBILE_PROVISION`).
6. `xcrun altool --upload-app` → App Store Connect → **Internal** TestFlight.
   The workflow does not submit for App Review and does not add external testers.

~15–20 min on `macos-latest`. Concurrency group `ios-testflight` — newer
runs cancel in-progress ones.

---

## One-time setup (Phil)

Do these once. After that, **Run workflow** is the only deploy step.

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

### 4 · App Store Connect API key (reuse Nuvo's)

Same account-level key Nuvo already uses. If the zeroed repo does not inherit
org/account secrets, copy these **names** from Nuvo:

| Secret | Required | Value |
|---|---|---|
| `APPLE_TEAM_ID` | yes | 10-char Team ID (Membership page) |
| `APPSTORE_KEY_ID` | yes | App Store Connect API Key ID |
| `APPSTORE_ISSUER_ID` | yes | App Store Connect Issuer ID |
| `APPSTORE_PRIVATE_KEY` | yes | Base64 of the `.p8` file |
| `IOS_CERTIFICATE` | yes | Base64 of Apple Distribution `.p12` |
| `IOS_CERTIFICATE_PASSWORD` | yes | `.p12` export password |

`base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy` if you need to re-encode the key.

> **Do not reuse the macOS Developer ID cert.** App Store / TestFlight
> requires **Apple Distribution** — Nuvo's iOS `IOS_CERTIFICATE` is the
> right one; the desktop `release.yml` cert is not.

### 5 · NEW secrets / profile / variable (Zeroed-only)

Nuvo's App Store provisioning profile is bound to `day.nuvo.app` and
**cannot** sign Zeroed. Create an App Store Connect **distribution**
profile for `app.zeroed.app` and add the web build env:

| Name | Kind | Why it's new |
|---|---|---|
| `VITE_SUPABASE_URL` | secret | Zeroed's Supabase project (same value as Vercel Production). Used only while `VITE_API_BASE_URL` is empty. |
| `VITE_SUPABASE_ANON_KEY` | secret | Zeroed's anon key (same value as Vercel Production). Used only while `VITE_API_BASE_URL` is empty. |
| `IOS_MOBILE_PROVISION` | secret | Base64 of an **App Store Connect** distribution profile for `app.zeroed.app` |
| `VITE_API_BASE_URL` | **variable** | Leave empty until Cloudflare cutover. Then set to `https://<worker>/api`. See [`cloudflare-cutover.md`](./cloudflare-cutover.md). |

To make the distribution profile:

1. Developer portal → **Profiles** → **+** → **App Store Connect**.
2. App ID `app.zeroed.app` → link the **Apple Distribution** cert.
3. Download `.mobileprovision`, then
   `base64 -i Zeroed.mobileprovision | pbcopy`.

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

1. Finish steps 2–5 above (App ID, ASC app record, distribution profile, secrets).
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
| Workflow fails at signing | Check `APPLE_TEAM_ID` and the three `IOS_*` secrets |
| `No profiles for app.zeroed.app` | Create the App ID + wait a few minutes; or add `IOS_MOBILE_PROVISION` |
| Upload rejected (SDK too old) | Bump `runs-on:` to a newer `macos-*` in `ios-release.yml` |
| Build not in TestFlight | App Store Connect → Activity; check email for compliance questions |
| Encryption export questionnaire | `ITSAppUsesNonExemptEncryption=false` is set in `ios/App/App/Info.plist` |
| Icon rejected (90717 alpha channel) | Re-run `python3 scripts/gen-icons.py` — it writes RGB, no alpha |
| `cap sync` on Linux skips pods | Expected. CI is `macos-latest` and runs CocoaPods |

---

## Rotating credentials

Same as Nuvo: new ASC API key → update the three `APPSTORE_*` secrets and
revoke the old key. Distribution cert renews yearly; re-export `.p12` and
update `IOS_CERTIFICATE` / `IOS_CERTIFICATE_PASSWORD`. The Zeroed
provisioning profile is independent of Nuvo's — regenerate it if the cert
or App ID changes.
