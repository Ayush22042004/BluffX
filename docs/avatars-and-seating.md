# Custom avatars and clockwise seats

Players can open My Profile, choose Upload avatar photo, preview the crop, and save. PNG, JPEG and WebP files up to 5 MB are resized in the browser. Choosing a preset removes the uploaded account photo. Accounts keep their avatar across sign-ins; guests keep an avatar ID in their browser profile.

The backend independently validates and re-encodes images as 128×128 WebP, strips metadata, and limits encoded uploads to 512 KB and stored images to 32 KB. Images live in PostgreSQL, not Render's filesystem. Room events carry only the image ID. Image responses use immutable URLs and a bounded server cache. Replacing an image deletes the previous stored image; unclaimed guest images expire after 30 days. Uploaded avatars are public profile pictures.

AI opponents are named Bot 1, Bot 2 and so on, including recovered old seats and the tutorial. Human names are preserved. The table rotates the authoritative seat order around the local player: the next seat is on the left, then across the top and down the right, clockwise. Numbered badges and the player list show that same server order. No gameplay turn rules change.

## Migration and release

`server/migrations/003_player_avatars.sql` adds the avatar table and guest-expiry index without changing accounts or historical results. It has been tested on the isolated Neon test branch, including photo recovery after an actual server restart. It has **not** been applied to production.

Before starting the updated backend, review and run `npm run db:migrate-games` against the intended database, following the existing maintenance procedure in [deployment.md](deployment.md). This also applies any missing earlier game migrations. Do not reset the database. Install server dependencies with `npm ci --omit=dev` to include Sharp, then release the backend and frontend together. No new environment variables or paid services are required.

## Verification

- `npm test`: 75 tests, 73 passed, two database-only suites skipped in this mode.
- `npm run test:postgres`: 16 passed against the isolated Neon branch, including binary avatar persistence across process termination and recovery.
- `npm run build`: passed.
- `npm run test:e2e`: 16 passed, using isolated frontend/backend ports.
- Browser coverage includes signed-in upload and reload, guest upload and preset replacement, six-seat mobile geometry, and clockwise positioning from a non-host seat.

Browser tests use ports 4020/5180. Their backend uses a larger setup-event allowance because independent browser contexts share one loopback address; production defaults remain unchanged and separate flood tests cover rate limiting.
