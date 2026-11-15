# Table voice chat

For the current development release, see the [v0.3.0 record](versions/v0.3.0.md) and [SFU/cost assessment](voice-sfu-assessment.md). Voice remains mesh, not SFU. Local ten-participant connectivity has been exercised; physical-device and mobile signoff remain pending.

In a lobby or match, select **Join Voice** to listen, then **Unmute Mic** to grant microphone access and speak. Joining never opens the microphone. Muting stops and releases the capture device while keeping the call connected. Mute controls what you send; Deafen controls what you hear and does not mute your microphone. Use individual volume sliders to quiet or silence a player. A green indicator shows detected speech. Leave Voice stops capture immediately. Leaving the table, removal, logout, socket disconnection, and navigation away also close audio connections. Reconnecting or refreshing requires deliberately joining voice again. Voice never resets AFK strikes or changes game deadlines.

The browser uses native WebRTC audio. Table Voice defaults to Headphones mode with echo cancellation off; select Speakers to enable echo protection. Automatic gain control is off to avoid independent capture sessions changing microphone gain. Noise reduction is optional and starts off to avoid filtering quiet speech. Each participant connects to other opted-in humans in the same table (up to nine peers for ten seats). No audio, recordings, speech indicators, SDP, or ICE candidates are stored in PostgreSQL. Render only forwards bounded, rate-limited signaling to authorized seats; no server audio processing or recurring database writes are introduced. Speech detection runs locally four times per second only while voice is joined. Direct peer connections can reveal network addresses to participants; do not treat voice as an anonymity service.

## Connectivity and deployment

Microphone capture requires HTTPS in production; localhost works for development. The existing Socket.IO proxy carries signaling, so no new Vercel rewrites or server ports are needed. Deploy frontend and backend together through the normal reviewed release process. Voice requires no schema migration; the earlier avatar/game migrations still apply. No production deployment has been performed for this feature.

| Backend environment variable | Default / purpose |
| --- | --- |
| `VOICE_TURN_PROVIDER` | `cloudflare` enables temporary credentials from the configured Cloudflare TURN key |
| `CLOUDFLARE_TURN_KEY_ID` | Cloudflare TURN key ID, not account ID; backend only |
| `CLOUDFLARE_TURN_API_TOKEN` | Key-specific API token; backend only |
| `VOICE_RELAY_ONLY` | `false`; force relay only for explicit diagnosis |
| `VOICE_STUN_URL` | `stun:stun.l.google.com:19302`; discovers direct connection candidates |
| `VOICE_TURN_URL` | Optional comma-separated `turn:`/`turns:` relay URLs |
| `VOICE_TURN_SECRET` | Optional TURN REST shared authentication secret; backend only |

For the shared-secret TURN REST option, TURN URLs and the shared secret must both be configured. That option generates per-seat HMAC credentials valid for 24 hours and requires a relay supporting the same secret. Cloudflare mode instead uses its key ID/API token to obtain temporary ICE credentials. Only temporary credentials reach authorized voice participants. Do not put provider tokens or shared secrets in `VITE_` variables. Relay bandwidth is handled by the chosen relay, not Render. No paid service has been added automatically; provider overages are possible and a free allowance is not a spending cap.

STUN-only connections are not guaranteed across mobile carriers, restrictive routers, VPNs, or corporate firewalls. A TURN relay is needed for reliable cross-network coverage. Failed connections show a retry message instead of blocking gameplay. After the credentials were corrected on 2026-11-13, Cloudflare credential generation and a forced-relay two-browser audio test passed, including selected-relay verification and 40 decoded samples without silence. The v0.3.0 ten-context experiment used local direct connections, not cloud relay traffic. Renew expired relay credentials by leaving and rejoining voice. Large/mobile calls still require device testing; SFU remains inactive under the zero-spend restriction.

## Verification

`server/test/voice.test.js` exercises real Socket.IO membership, cross-room rejection, signaling validation, mute state, disconnect/removal cleanup, event flood limits, and zero game-state writes from voice traffic.

`client/tests/voice.spec.js` launches two independent Chrome contexts with synthetic microphones and real RTCPeerConnections. It checks established audio connections and received RTP bytes, default mute, unmute/mute track state, deafen, individual volume controls, stopped tracks after leave, no automatic capture after reload, and microphone-denial feedback. These tests run on isolated ports 4020/5180. Physical microphones, mobile devices, remote networks, and TURN relays still need device testing before claiming universal voice connectivity.

Release verification: `npm test` passed 78 tests with two database-only suites skipped; `npm run test:e2e` passed all 21 browser tests; `npm run build` passed. The voice tests also cover leaving and rejoining without a socket change and rejecting signaling from a previous voice session.

Reference: [WebRTC peer connections and ICE servers](https://webrtc.org/getting-started/peer-connections) and [microphone capture requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

## Continuous microphone behavior

Voice uses an open microphone after unmuting. Speech detection only changes the green activity dot; it never mutes tracks, pauses playback, or renegotiates the connection. The member label stays Mic on. A 1.2-second activity hold and separate start/continue thresholds prevent flicker between words. The local meter uses floating-point samples over a larger analysis window. Enable Noise reduction only if background noise needs filtering. Mute first to change the audio mode or noise reduction; those constraints apply on the next unmute, never repeatedly during speech. Voice reports include actual processing settings and sampled clipping without recording audio. See [headphone capture continuity](versions/v0.3.0-headphone-capture.md).

The two-browser test samples the live microphone repeatedly and checks that received audio bytes continue increasing while the activity meter runs. This verifies the local WebRTC path; it does not reproduce every physical microphone, browser filter, or external-network packet-loss condition.

## Same-computer testing and transport repair

For normal/incognito testing on one computer, join both tabs, unmute **only the sending tab**, and leave the receiving tab muted. The receiving tab no longer captures the same physical microphone. Mute stops capture; unmute acquires a fresh track and replaces the sender track in the existing negotiated call. It does not close peer connections. Both sides negotiate one send/receive audio transceiver, so either tab can take over speaking after the other mutes. Denied microphone permission leaves listening available.

Remote playback elements are attached to the document and are retained across renegotiation. Where supported, receivers request a 120 ms jitter buffer; audio senders are capped at 32 kbps with mono capture. Persistent peer disconnection triggers a bounded ICE-restart attempt by the designated offerer, without rebuilding the microphone. Game socket disconnects still stop voice immediately according to the existing seat-authorization policy.

Voice connection details samples aggregate packet loss, jitter, round-trip time, concealment and direct/relay route only while opened. Copy voice report contains no candidate addresses, SDP, resume tokens or relay credentials. This helps distinguish microphone/playback problems from an actual transport problem.

The strengthened browser test uses a continuous WAV source with two isolated browser contexts. It verifies 40 decoded playback samples with no silent gaps, zero capture requests in the listening tab, capture release on mute, reverse-direction decoded audio, and an ICE restart following a simulated disconnected-state event. Synthetic playback is not a guarantee for every physical headset or driver.
