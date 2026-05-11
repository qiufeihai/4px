# Mobile Clients

This directory hosts mobile client work for 4px.

Current layout:

- `android/`: Android client（已完成 MVP）
- `ios/`: iOS client（控制面 MVP 进行中）

Shared direction:

- Reuse Go `clientcore` via `gomobile` bridge
- Keep UI minimal with Chinese copy
- Provide localized error hints, expiry query, and local logs
- iOS supports local script and manual GitHub workflow build
- iOS data-plane uses PacketTunnel Extension skeleton
