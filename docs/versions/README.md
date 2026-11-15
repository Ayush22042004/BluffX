# BluffX version history

Each update gets its own document in this directory. Record implemented behavior, verification, migrations, configuration, compatibility and remaining work before releasing it. A document records code status separately from production deployment status.

| Update | Package version | Status | Record |
| --- | --- | --- | --- |
| `v0.3.0` combined update rollout | `0.3.0` | Live on Render/Vercel at `f8932ca`; production migrations 007/008 verified, accounts/results preserved | [Rollout record](v0.3.0-update-rollout.md) |
| `v0.3.0` records/mobile hotfix | `0.3.0` | Personal totals include saved casual wins; tolerant heartbeat and page recovery; migration 008 required before rollout | [Hotfix implementation record](v0.3.0-records-mobile.md) |
| `v0.3.0` persistent parties | `0.3.0` | Friend party invites and voice across games; local implementation, migration 007 required before rollout | [Party implementation record](v0.3.0-parties.md) |
| `v0.3.0` deployment recovery | `0.3.0` | Separate local/production ownership and bootstrap empty CI databases | [Deployment recovery record](v0.3.0-deployment-recovery.md) |
| `v0.3.0` final release audit | `0.3.0` | Public frontend/backend verified at `4139f1f` on 2026-11-15; physical-device qualification remains | [Final audit and deployment handoff](v0.3.0-final-audit.md) |
| `v0.3.0` reporter contact details | `0.3.0` | Trusted player name, Player Code and contact email in private support notifications; local only | [Report contact record](v0.3.0-report-contact.md) |
| `v0.3.0` Gmail API delivery | `0.3.0` | Existing Gmail mailbox over HTTPS, private owner authorization; local only | [Gmail implementation record](v0.3.0-gmail-api.md) |
| `v0.3.0` Brevo email alternative | `0.3.0` | HTTPS transactional email and provider-safe report retries; local only | [Brevo update record](v0.3.0-brevo.md) |
| `v0.3.0` speaking indicators | `0.3.0` | Speaker badges, avatar rings and clear player/member highlights; local only | [Speaking UI record](v0.3.0-speaking-indicators.md) |
| `v0.3.0` voice setup UI | `0.3.0` | Themed Headphones/Speakers cards with clear descriptions; local only | [Voice selector record](v0.3.0-voice-setup-ui.md) |
| `v0.3.0` headphone capture | `0.3.0` | Natural headphone mode, speaker echo protection and input diagnostics; local only | [Voice capture record](v0.3.0-headphone-capture.md) |
| `v0.3.0` audit fixes | `0.3.0` | Overlay, action feedback, transport, security and loading hardening; local only | [Fix implementation record](v0.3.0-reliability-fixes.md) |
| `v0.3.0` table settings | `0.3.0` | Responsive settings rows and clear save/cancel actions; local only | [Table settings record](v0.3.0-table-settings.md) |
| `v0.3.0` original Pink restoration | `0.3.0` | Original v3 Pink and stronger complementary theme colors; local only | [Restoration record](v0.3.0-original-pink.md) |
| `v0.3.0` coordinated palettes | `0.3.0` | Multicolor palettes for all three themes; local only | [Palette update record](v0.3.0-theme-palettes.md) |
| `v0.3.0` theme picker follow-up | `0.3.0` | Three saved player-selectable themes; local only | [Theme picker record](v0.3.0-theme-picker.md) |
| `v0.3.0` neon blue follow-up | `0.3.0` | Blue interface accents, navy surfaces and scenic tint; local only | [Theme update record](v0.3.0-neon-blue.md) |
| `v0.3.0` Resend follow-up | `0.3.0` | Durable report notifications and setup checks; local only | [Resend update record](v0.3.0-resend.md) |
| `v0.3.0` social follow-up | `0.3.0` | Visible social rail, Player Codes and friend-request drawer; local only | [Social update record](v0.3.0-social-sidebar.md) |
| `v0.3.0` UI follow-up | `0.3.0` | Setup polish, compact beta label and desktop fullscreen recommendation; local only | [UI update record](v0.3.0-ui-polish.md) |
| `v0.3.0` multiplayer/social release | `0.3.0` | Local implementation and verification; not deployed | [Implementation and limitations](v0.3.0.md) |
| Beta version 2 / `v0.2.0-beta.2` development cycle | `0.2.0` | Implemented and locally verified; production rollout pending as of 2026-11-13 | [Complete implementation record](beta-v2.md) |

The earlier live deployment last checked on 2026-11-13 reported `0.2.0-beta.1`. No retrospective beta.1 release certification is implied by this index. The beta version 2 record includes the accumulated reliability overhaul and subsequent avatar, UI, voice and playtest-readiness updates.

For every future update:

1. Copy [the version template](TEMPLATE.md) into a new version-named file; never overwrite an older release record with a different release.
2. Describe actual code changes and link the main implementation files. Distinguish inherited functionality from newly changed behavior.
3. Record exact test commands, actual results and dates. Leave unperformed checks marked pending.
4. List migrations, environment variable names/defaults and rollout/rollback considerations. Never include secret values.
5. Add a row here and link the update from the root README. Set a deployment date and revision only after deployment is verified.

Minor follow-ups within the same unreleased cycle can be appended as dated entries in that cycle's document. Once published, preserve its release evidence and create a new document for the next update.
