# Settings editor live evaluation — 12.11.2026

Two isolated source-loaded Pi-Bolt instances shared a disposable `ACCORDION_HOME`; a third used an environment-locked token. All provider routes were synthetic, and no provider calls were made. Pi ran offline in private tmux socket `acc-settings-s3`.

- Exercised Settings, conductor picker and dirty-reload confirmation at 36, 57, 80 and 140 columns × 16 rows. The `s3-*` text and ANSI captures retain the visible screen and size. Unicode width checks passed; rendered narrow and wide captures were inspected. Descriptions truncate at 36 columns, but the safe action and confirmation choices remain visible.
- Changed 29 scalar settings through the editor and checked both that each changed and that the other Pi adopted the values. Token changes were compared by hash, not recorded. Peer adoption: 336 ms.
- Saved model wildcard budget, tail and timing; both default model routes; chat and classifier overrides for all eight conductors; and a free isolated door port. Peer adoption of the route batch: 523 ms.
- Verified session-only folding, budget and tail, confirmed dirty reload discards staged values, and confirmed an environment-locked token cannot be regenerated. Revoking consent through the panel detached a remote-routed Taskfold while preserving a synthetic task fold's digest.
- The first privacy attempt hit an incorrect test-harness assumption that the 140-column capture was 16 rows; the operation was resumed and verified at 140×40. The first session-dial attempt raced the scope dialog; waiting for the dialog resolved the harness failure. Redacted credential snapshots were compared by hash in the final scalar run.

Automated gates on the same code: `bun test extension/settings.test.ts extension/tui/*.test.ts` (160 passed), `npm --prefix extension run smoke` (passed), `npm --prefix app run check` (0 errors, 0 warnings), and `npm --prefix app test` (1,080 passed, 21 skipped). The standalone extension TypeScript baseline still has seven previously documented errors.
