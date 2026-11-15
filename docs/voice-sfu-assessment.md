# v0.3.0 voice architecture and cost assessment

Reviewed 2026-11-13. The existing architecture is WebRTC mesh with server-authorized Socket.IO signaling and optional Cloudflare TURN credentials. It is not Cloudflare SFU. No SFU sessions, applications or billable routing paths were activated by this release.

## Cost gate

Cloudflare's [published Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) lists a shared SFU/TURN allowance of 1,000 GB monthly, followed by $0.05 per GB egress. Its [resource limits](https://developers.cloudflare.com/realtime/sfu/platform/limits/) describe technical limits, not a guaranteed zero-spend account cap. We have not verified a provider-enforced hard spending stop for this account. A software budget or usage alert would not satisfy the user's zero-cost restriction.

**Decision: do not activate SFU.** An existing SFU application does not authorize spending. The established mesh/TURN configuration remains intact, including its regression test. Existing TURN use also has potential overages under the shared pricing; retaining it is not a guarantee of zero account charges. Confirm provider-level billing controls separately before increasing production voice usage. No overage billing, new resource or account setting was enabled automatically.

## Technical tradeoff

Ten joined mesh participants create nine peer connections per browser: 90 directed browser-side peer connections across the table. A publishing browser sends a separate stream to each listener. SFU could reduce each publisher to one uplink and one media connection while the service forwards subscriptions, helping upload-constrained/mobile devices. That benefit requires a new authorized session/subscription lifecycle and must be measured against real devices and provider behavior; possession of an application key is insufficient evidence.

The existing mesh path retains continuous transmission, mute/release/replaceTrack behavior, deafen, per-peer volume, activity indicators, echo cancellation, optional noise suppression, bounded restart, redacted diagnostics and cleanup. A host may disable optional table voice; gameplay remains available.

## Local ten-person experiment

Run explicitly on isolated 4020/5180 test ports:

```powershell
$env:BLUFFX_LARGE_VOICE='true'
npm --prefix client run test:e2e -- voice-large.spec.js
```

The test fixture disables TURN, uses one local Chrome with ten isolated contexts and synthetic microphone input, and exercises the actual application voice path. It does not generate cloud media usage. The ordinary browser command skips this heavier experiment unless explicitly enabled.

Observed on 2026-11-13:

- All ten contexts connected to nine peers each.
- One speaker's RTP sender traffic was approximately 167.0 kbps across nine streams during a three-second measurement window.
- All nine listeners received RTP; sampled loss was zero and maximum reported jitter was 1 ms.
- Reported host-page JavaScript heap was about 11.6 MiB. This is not total browser memory or backend RSS.
- A host-page headless animation-frame sample was about 144.7 frames/second in the lobby. This is not gameplay FPS or evidence of mobile smoothness.

Raw result: [v3-ten-voice.json](performance/v3-ten-voice.json). The experiment had one simultaneous speaker, not ten, and excludes network/transport overhead from RTP byte counts. It does not measure physical headsets, mobile capture, restrictive networks, real TURN relay performance, browser process CPU or Render capacity. Those remain staging/device playtest requirements.

Any later SFU milestone must first demonstrate a provider-enforced zero-spend limit or obtain a changed cost authorization, then add server-only application credentials, seat-scoped publish/subscribe authorization, room isolation, teardown and regression coverage. No unfinished SFU implementation is presented as enabled here.
