# Mobile Clients

This directory hosts mobile client work for 4px.

Current plan:

- `android/`: Android client (MVP first)
- `ios/`: iOS client (future)

MVP scope for Android:

- Basic config form
- Connect/disconnect state
- Placeholder for VPNService integration
- Reuse existing 4px server endpoints and auth model

## Current decision

- Android work is paused for now due to missing local Android toolchain.
- Existing skeleton under `apps/mobile/android` remains as the resume baseline.

## Resume checklist (for future AI continuation)

1. Install Android prerequisites on macOS:
   - JDK 17
   - Android command-line tools (or Android Studio)
   - Android SDK platform/build-tools/platform-tools
2. Open and sync project at `apps/mobile/android`.
3. Build debug APK and verify output under `app/build/outputs/apk/debug/`.
4. Continue implementation in this order:
   - Config persistence
   - Connect/disconnect state machine
   - VPNService tunnel integration
   - proxy-v2 default wiring and runtime diagnostics
