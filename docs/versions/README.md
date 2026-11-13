# BluffX version history

Each update gets its own document in this directory. Record implemented behavior, verification, migrations, configuration, compatibility and remaining work before releasing it. A document records code status separately from production deployment status.

| Update | Package version | Status | Record |
| --- | --- | --- | --- |
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
