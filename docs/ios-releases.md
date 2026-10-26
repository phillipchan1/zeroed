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
job **fails** if the Apple / Distribution signing secrets are missing — it
does not mint or revoke certificates as a fallback.

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

1. Checks that the Apple + Distribution signing secrets exist. If any are
   missing, the workflow **fails** with an error listing what is absent.
   There is no automatic-signing fallback and no certificate create/revoke.
2. Stamps version `<major>.<minor>.<commit_count>` — patch is
   `git rev-list --count HEAD` (same scheme as Nuvo).
3. Checks that build number against App Store Connect
   (`scripts/appstore-next-build-number.mjs`) and bumps past it if this
   exact version was already uploaded (manual re-run of the same commit).
4. `npm ci` → `vite build` → `npx cap sync ios`.
   `VITE_API_BASE_URL` comes from a **repo variable**. When it is empty,
   the build bakes `VITE_SUPABASE_*` (today's path). When it is set, it
   must be an **absolute** `https://<worker>/api` — a relative `/api`
   resolves against `capacitor://localhost` and never reaches the Worker
   — and `VITE_SUPABASE_*` are **not** baked. See
   [`cloudflare-cutover.md`](./cloudflare-cutover.md) § iOS TestFlight at cutover.
5. After the web build, write the App Store Connect `.p8` under
   `$RUNNER_TEMP/zeroed-asc.p8` with `umask 077` (raw PEM or base64). Copy
   to `~/.appstoreconnect/private_keys/AuthKey_<id>.p8` for `altool`
   (upload + build-number only — not for signing).
6. Import the Apple Distribution `.p12` and App Store `.mobileprovision`
   into a temporary keychain. Then write `CODE_SIGN_STYLE=Manual`,
   `CODE_SIGN_IDENTITY='Apple Distribution'`,
   `PROVISIONING_PROFILE_SPECIFIER`, and `DEVELOPMENT_TEAM` onto the
   **App target only** (`scripts/ios-apply-app-signing.mjs`) and
   `xcodebuild archive`. Those settings are not passed as xcodebuild
   flags — command-line `SETTING=value` applies to every target,
   including CocoaPods (`CODE_SIGNING_ALLOWED=NO`, `org.cocoapods.*`
   bundle ids). Export with `method=app-store` and `signingStyle=manual`.
   Do not pass allowProvisioningUpdates.
7. `xcrun altool --upload-app` → App Store Connect → **Internal** TestFlight.
   The workflow does not submit for App Review and does not add external testers.
8. An `always()` step deletes the temporary keychain, the imported `.p12`
   / profile, `${{ runner.temp }}/zeroed-asc.p8`, and
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
App Store Connect API) with **App Manager** or **Admin**. The key is
used only to resolve the next build number and to upload the IPA with
`altool`. It is **not** used to create or revoke certificates.

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

### 5 · Apple Distribution certificate and App Store profile

CI signs with a certificate and profile you create **once** in the Apple
Developer portal. The runner imports them into a temporary keychain and
never calls Apple to create or revoke certificates.

#### Distribution certificate (`.p12`)

1. Prefer an **existing** Apple Distribution certificate on this team
   (Nuvo shares the team — do not revoke anything).
2. On a Mac that already has that certificate **and its private key** in
   Keychain Access: select **Apple Distribution: \<Team\>**,
   **File → Export Items…** → Personal Information Exchange (`.p12`),
   set a password.
3. If none exists: [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list)
   → **Certificates** → **+** → **Apple Distribution**. Create a CSR in
   Keychain Access (**Certificate Assistant → Request a Certificate From
   a Certificate Authority…**, save to disk). Upload the CSR, download
   the `.cer`, double-click to install, then export as `.p12` as above.
4. Encode the file (macOS):

   ```bash
   base64 -i AppleDistribution.p12 | pbcopy
   ```

#### App Store provisioning profile

1. [Profiles](https://developer.apple.com/account/resources/profiles/list)
   → **+** → **App Store Connect** (iOS App Store) → App ID
   **`app.zeroed.app`** → select the same Distribution certificate →
   download the `.mobileprovision`.
2. Encode:

   ```bash
   base64 -i Zeroed_AppStore.mobileprovision | pbcopy
   ```

| Secret | Required | Value |
|---|---|---|
| `IOS_DIST_CERT_P12_BASE64` | yes | base64 of the Apple Distribution `.p12` |
| `IOS_DIST_CERT_PASSWORD` | yes | password you set when exporting the `.p12` |
| `IOS_APPSTORE_PROFILE_BASE64` | yes | base64 of the App Store `.mobileprovision` |

Paste each value under Settings → Secrets and variables → Actions.
Missing any of these **fails** the workflow with an error. There is no
automatic-signing fallback.

When you renew the Distribution cert or regenerate the profile, re-export,
re-encode, and update the same three secrets. Do not let CI create or
revoke certificates.

### 6 · NEW secrets / variable (Zeroed-only)

| Name | Kind | Why it's new |
|---|---|---|
| `VITE_SUPABASE_URL` | secret | Zeroed's Supabase project (same value as Vercel Production). Used only while `VITE_API_BASE_URL` is empty. |
| `VITE_SUPABASE_ANON_KEY` | secret | Zeroed's anon key (same value as Vercel Production). Used only while `VITE_API_BASE_URL` is empty. |
| `VITE_API_BASE_URL` | **variable** | Leave empty until Cloudflare cutover. Then set to an **absolute** `https://<worker>/api` — relative `/api` is rejected in CI. See [`cloudflare-cutover.md`](./cloudflare-cutover.md). |

Settings → Secrets and variables → Actions on **phillipchan1/zeroed**.
This repo does not change secrets for you. Until they exist, the
TestFlight workflow **fails** and lists the missing names.

### 7 · TestFlight internal testing

1. After the first CI upload succeeds, the build appears in
   App Store Connect → **TestFlight** (~5–15 min processing).
2. **Internal Testing** → create group → add yourself.
3. Install **TestFlight** on the iPhone → accept the invite → install Zeroed.
4. TestFlight → **Settings** → enable **Automatic Updates**.

Internal testers get builds without App Review. Skip external testers / Beta
App Review for personal dogfooding.

---

## Trigger the first build

1. Finish steps 2–6 above (App ID, ASC app record, API key, Distribution
   `.p12` + App Store profile, Zeroed secrets).
2. Merge to `master` (automatic) **or** GitHub → **phillipchan1/zeroed** →
   **Actions** → **iOS TestFlight** → **Run workflow**. Dispatch from this
   PR's branch to smoke-test the pipeline before merge.
3. Watch the `testflight` job. Upload prints
   `Uploading … (v<version>, build <n>) to Internal TestFlight`.
   If secrets are still missing, **Check TestFlight secrets** fails with
   an error listing what to add. The workflow will not sign automatically
   and will not create or revoke certificates.
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
| Workflow fails at **Check TestFlight secrets** | Missing secrets listed in the error — add `IOS_DIST_CERT_*`, `IOS_APPSTORE_PROFILE_BASE64`, `ASC_API_KEY_*`, and `APPLE_TEAM_ID` |
| Workflow fails at signing | Re-export the Apple Distribution `.p12` (must include the private key) and an App Store profile for `app.zeroed.app`. Confirm `IOS_DIST_CERT_PASSWORD` matches |
| `No profiles for app.zeroed.app` | Create an App Store provisioning profile for the App ID and set `IOS_APPSTORE_PROFILE_BASE64` |
| `Choose a certificate to revoke` / `iOS App Development provisioning profiles` | The archive is still requesting a Development cert. Confirm the workflow does not pass allowProvisioningUpdates and that `ios-apply-app-signing.mjs` wrote Manual / Apple Distribution onto the App target. Do not revoke Distribution certs — Nuvo shares this team |
| Upload rejected (SDK too old) | Bump `runs-on:` to a newer `macos-*` in `ios-release.yml` |
| ITMS-90685 CFBundleIdentifier collision | Do not pass `PRODUCT_BUNDLE_IDENTIFIER` to `xcodebuild`. Pod frameworks (`Capacitor`, `CapacitorCordova`, `Pods_App`) inherit it. The Podfile pins them to `org.cocoapods.*`; CI unzips the IPA and fails on a duplicate. |
| ITMS-90474 iPad orientations | `UIRequiresFullScreen=true` in `Info.plist` (portrait-only). |
| 90068 deployment target | `IPHONEOS_DEPLOYMENT_TARGET` / `platform :ios` are **15.0** |
| Build not in TestFlight | App Store Connect → Activity; check email for compliance questions |
| Encryption export questionnaire | `ITSAppUsesNonExemptEncryption=false` is set in `ios/App/App/Info.plist` |
| Icon rejected (90717 alpha channel) | Re-run `python3 scripts/gen-icons.py` — it writes RGB, no alpha |
| `cap sync` on Linux skips pods | Expected. CI is `macos-latest` and runs CocoaPods |
| Sign-in works on the PWA but the iOS app cannot load/save | The iOS build baked a relative `VITE_API_BASE_URL=/api`. Rebuild with `https://<worker>/api`. |

---

## Rotating credentials

New ASC API key → update `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, and
`ASC_API_KEY_P8`, then revoke the old key. That key is upload-only.

New Distribution certificate or App Store profile → re-export the `.p12`
and `.mobileprovision`, re-encode, and update `IOS_DIST_CERT_P12_BASE64`,
`IOS_DIST_CERT_PASSWORD`, and `IOS_APPSTORE_PROFILE_BASE64`. The workflow
never creates or revokes certificates.
