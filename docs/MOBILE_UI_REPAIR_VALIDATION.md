# Mobile navigation and settings repair — 2026-10-12

## Scope
- On phones, Images, Scheduled tasks, Library and Plugins belong to the native Explore menu by default. Only explicit native pin overrides expose them directly. Desktop classification is unchanged.
- Chat drawer account spacing and column transforms no longer apply to settings. Existing search and horizontal setting categories are preserved; no preference values or permissions are changed.
- Native renderer routing is patched atomically against audited Windows and Linux source descriptors. Unknown source remains unchanged. No copied DOM, alternate account state, authentication bypass, or entitlement change.

## Automated verification
- `pnpm run build`: passed.
- Focused navigation, layout, auto-collapse, keyboard, settings and Linux packaging tests: 56 passed, no skips/failures. Includes parse-only checks of both real Windows/Linux renderer modules; vendor code not executed by fixture checks.
- Broader static/assets, cue and performance checks have 14 existing failures. The same failures reproduce with pre-change static-assets loaded from Git `0a05d38`; they are not represented as passing or repaired by this change.
- Installed code hashes match repository source. Existing config, account/session files and official runtime remain untouched.

## Browser verification
- Settings classification and Language search result navigation work on the installed app; no setting switches changed.
- Category buttons keep 44px height at 320x740, 390x844, 485x719 and 844x390; desktop checked at 1100x780.
- Final native Explore pin/unpin acceptance awaits normal user login after the required application restart.
- Android physical device and VPN-off startup are not tested by this UI repair.

## 2026-10-13: live phone-hosted service acceptance

An Android ARM64 test device running a Kali service was exercised from a desktop Chromium client at 390×844, 320×740 and 844×390. This verifies the real phone-hosted backend and responsive web flows; it does not establish Android keyboard, touch or PWA acceptance.

- Normal login, historical conversation loading, multiline Chinese/English input, refresh with draft retention, model menu, settings search, Explore and scheduled-task navigation passed.
- A single test conversation received a response in about eight seconds; file-operation requests were not part of this acceptance.
- Current Linux renderer used a third New Chat icon. Added its precise prefix in `5cd7e91`; selecting New Chat now closes the drawer on the live service. Regression results: 37 passed, two optional real-renderer fixtures skipped.
- A controlled service restart invalidated the existing in-memory access token as designed. The page previously retried without explaining the login failure. `b346829` adds a bounded, generation-scoped same-origin auth check and explicit sign-in prompt without automatic reload or message replay. All 133 targeted regressions passed. A second real restart confirmed the new expired-login state, retained drafts, and the working sign-in entry.
- During the outage, added text remained available in the local draft-copy panel after reauthentication. The official composer restored its earlier draft; the local copy retained the offline addition for deliberate recovery.
- Final live health: one CLI, IPC ready, seven checks passed, zero abnormal compatibility points; five points remained pending. Phone deployment files and runtime snapshots passed content verification.
- The normal access-password form and Enter button remained usable across the restart and reauthentication checks.

Still unverified: actual Android IME/touch, attachments, command approvals, long streaming sessions, Wi-Fi transitions and background durability. Desktop network emulation alone was not counted as a verified physical-device outage.
