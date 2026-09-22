# Migration domain audit (2026-09-22)

This is a read-only audit of the migration worktree at `codex/go-migration`,
HEAD `4e4466e034f4e8ce6b30a109ce3b1bebe8a1cd3b`. It records what the current
legacy scanner can observe, what the Go schema can store, and the boundary that
must be closed before an import or cutover can be approved. No production data,
credentials, or running service were accessed.

## Current command boundary (audit point)

At the audit point (the committed source named above),
`server-go/cmd/import-legacy/main.go` was explicitly an M0 read-only command.
It accepted only `--snapshot DIR`, `--source-version VERSION`, and an output
report path outside the snapshot. It called `legacy.Scan`, wrote a new report
with mode `0600`, never overwrote an existing report, and returned:

- `0` when the scan found no findings (this is not import approval);
- `1` when findings are present;
- `2` for invalid arguments, unavailable input, or output failure.

`legacy.Scan` always leaves `importReady` false and emits pending work for
offline consistency, field/equipment references, companion services, a trial
import/reconciliation, and (when present) SQLite/WAL verification. There is no
PostgreSQL DSN, transaction, importer, source-to-new ID map, checkpoint,
rollback, or reconciliation command at that point. A successful scan was
therefore a read-only inventory result and could not be described as an import.

The scanner hashes every regular file and a deterministic manifest, rejects
symlinks, duplicate JSON keys, invalid UTF-8, unsafe numbers, and several
account/listing anomalies. It does not read SQLite pages or WAL records and it
cannot prove that independently copied files form one cross-file snapshot.

## Legacy persistence inventory

The authoritative Node paths are declared in `backend/server.js:56-87` and
the field groups used by administrative snapshots are at `backend/server.js:2951-2982`.
The scanner's `rootDomains` in `server-go/internal/legacy/scan.go:55-78`
recognizes these paths:

| Source path/domain | Fields or meaning | Import status in current tree |
| --- | --- | --- |
| `accounts/<safe>.json` | Identity (`username`, display name, QQ, password hash, MFA/admin/ban fields), `coins`, category inventory, `bigfish`, `codex`, catch count, equipment/rod state (`bd`, `rodSlots`, active slot/name), autosell and personal notification settings | Scanner validates only username, coins, inventory, password-hash presence, and the bigfish subset. Equipment references, identity compatibility, MFA, sessions, autosell, subscriptions, codex and all remaining fields are pending. |
| `market.json` | `listingSeq`, listings, `marketSupply` | Scanner validates listing seller/id/lid/qty/price and duplicate IDs. It does not validate escrow/equipment references, listing state transitions, supply semantics, or conservation against account inventory. |
| `records.json` | Big/small records, top lists, global maximum, rank and last record | Recognized as a required domain but not parsed or reconciled. |
| `economy.json` | Shop sales, price history/overrides, trade and market logs, economy audit log | Recognized but not parsed or reconciled. Historical log identity and monetary conservation are unverified. |
| `config.json` | Feature releases/order, world/spot overrides, formulas, drop/loot/chest/sea/mall/workshop/records configuration, banners, feedback/snapshot settings, revision fields | Recognized but not parsed. Versioned rule/catalog identity and effective configuration are unverified. |
| `feedback.json` | Feedback entries and cooldown metadata | Recognized but not parsed. |
| `stats.json` | Minute/hour/peak operational samples | Recognized but not parsed. |
| `admin.json` | Operator audit log | Recognized but not parsed. Sensitive operator names/details must remain in controlled evidence. |
| `sessions.json` | Player/admin session tokens and expiries | Recognized but not parsed. Sessions must not be imported as live credentials; cutover needs an explicit invalidation/re-login policy. |
| `users.json`, `world.json` | Pre-split monoliths retained by the Node bootstrap migration | Recognized as legacy monoliths and deliberately blocked pending versioned review. They are not safe substitutes for the split files. |
| `snapshots/<account>/<timestamp>.json` | Per-account asset rollback snapshots containing the `SNAPSHOT_ASSET_KEYS` subset | Classified as historical snapshots only. No restore/import semantics or relation to a chosen cutover point are implemented. |
| `wiki.db` plus `wiki.db-wal`/`wiki.db-shm` | Official guides, player submissions, moderation state, revisions and updates | Files are hashed/classified only. SQLite backup API/checkpoint/WAL pairing and JSON-to-SQLite consistency are not verified. |
| `wiki.json`, `wiki-guides.json` | Legacy Wiki sources read once by `backend/wiki-store.js` during SQLite migration | Classified but not parsed. The authoritative choice between these files and SQLite, and duplicate/revision reconciliation, remains open. |

The source inventory also declares `persistedDomainKeys` in
`server-go/api/legacy-inventory.json:1272-1389`; this is a static field list,
not proof that the Go database currently imports each field.

## Go persistence surface

The embedded migrations are 28 SQL files: `0001` through `0026`, plus the two
distinct files `0027_admin_market.sql` and `0027_record_hides.sql`. They create
these durable groups:

| Go group | Tables (migration) | Legacy source relationship |
| --- | --- | --- |
| Account/asset ledger | `accounts`, `player_state`, `wallets`, `asset_operations`, `asset_entries`, `command_results`, `outbox_events` (`0001`) | New authoritative ledger. Import must seed balances and append auditable opening operations; direct balance updates would violate the model. |
| Inventory/equipment/rods | `item_definitions`, `inventory_stacks`, `equipment_instances`, `rod_loadouts`, `rod_components`, `inventory_entries`, `equipment_entries`, `rod_entries` (`0002`) | Candidate targets for inventory, `bd`, and rod slots. Legacy component signatures and references have no implemented mapping yet. |
| Fishing state and prototype market | `fishing_rules`, connections/sessions/settlements, `market_listings` (`0003`) | Running sessions/connections are ephemeral cutover state; listings need explicit mapping to the later order model. |
| Identity/auth | `identities`, `auth_sessions`, `auth_attempts` (`0004`), registration guard tables (`0025`) | Password hash/salt compatibility, MFA handling and session invalidation are unimplemented. Tokens must not be copied. |
| Player history/trade | `player_events` (`0005`), `trades` (`0006`) | Legacy trade state/logs need state and participant mapping; no importer exists. |
| Market orders and escrow | `market_orders`, `market_order_equipment`, `market_fills`, `market_charges` (`0007`), plus prototype listings and `0027_admin_market` | Target for active orders and custodial assets. Requires per-order quantity/escrow/fee conservation checks. |
| Workshop/mall/codex | `random_intents`, `chest_pity`, `player_codex` (`0008`), `mall_purchases` (`0009`) | Codex can map to `bigfish`/records only after field-level rules; pity and random intents have no safe legacy equivalent. |
| Social/economy | `friend_relations` (`0010`), `economy_prices`, `shop_sales`, `autosell_settings` (`0011`) | Targets friends, price state, shop history and autosell. Legacy logs/config need schema-specific transforms and monetary reconciliation. |
| Operator/config/catalog | `operator_audit` (`0012`), `feature_releases`/`feature_head` (`0013`), `catalog_releases`/`catalog_head` (`0020`), operator settings/activity/admin audit (`0023`), banner state/events/watchers (`0024`) | Config and admin history need an operator-approved versioned import; audit tables are append-only and must preserve actor/time/details without secrets. |
| Sea/voyage/quests | `sea_players`, progress entries (`0014`); zones (`0015`); quest boards/roots (`0016`) | Candidate targets for `seaCfg` and player progress. Active voyages, private seeds and expiry need explicit cutover policy. |
| Parties | guard, parties, members, invites, events (`0017`) | Node `parties` is runtime-only according to the source comment; importing active parties still needs a policy for membership/invites and one authority. |
| Native fishing/records | native sessions/settlements, `catch_records` (`0018`), continuations/segments (`0019`), record hides (`0027_record_hides`) | Candidate target for catch count, personal codex and public records. Legacy record arrays are projections, not immutable catch rows; synthesizing rows requires a documented provenance and must reject ambiguous entries. |
| Legacy streams/notifications/feedback | `gateway_streams` (`0021`), `subscription_settings`, `feedback_entries`, `feedback_cooldowns` (`0022`) | Runtime leases and sessions should expire/re-authenticate; subscriptions/feedback require per-account mapping. |
| Wiki | `wiki_state`, `wiki_guides`, `wiki_sections`, `wiki_updates`, `wiki_revisions` (`0026`) | PostgreSQL Wiki target exists, but no importer or SQLite consistency check exists. Official embedded content and user/moderation revisions need an explicit precedence rule. |

The schema owner/migration role is separate from the runtime role in the
existing migration/test design, and `cmd/migrate` is the only DDL entrypoint.
That is useful for the later least-privilege drill, but it does not provide an
import role or an import transaction today.

## Snapshot and consistency requirements still open

Before a real snapshot is accepted, the operator runbook must record all of the
following in a manifest outside the source directory:

1. Enter a maintenance state that rejects new writes and drains in-flight
   requests, workers, SSE leases, fishing sessions, trade/market workers and
   Wiki writes. Record the stop timestamp and source build/version.
2. Record the exact file list, relative paths, byte lengths, SHA-256 hashes,
   ownership/mode, source commit/version and a monotonic snapshot ID. Do not
   include account names or secret values in the ordinary report.
3. Copy to an isolated staging directory with filesystem metadata preserved,
   then hash the destination and compare every manifest row. A live recursive
   copy is reference material only; it is not a consistency proof.
4. For `wiki.db`, use SQLite's backup/online-backup procedure while writes are
   stopped, or checkpoint and copy the database together with matching WAL/SHM
   state. Open the copy read-only and run `PRAGMA integrity_check` plus row and
   revision counts. Compare legacy `wiki.json`/`wiki-guides.json` only as an
   explicit migration input, never by silently choosing whichever parses.
5. Freeze the manifest and retain the source-version declaration, stop/drain
   evidence, copy verification, SQLite checks, and all subsequent import and
   reconciliation evidence under controlled storage.

The current scanner performs item 2 partially and detects some mid-read file
changes, but it cannot establish items 1, 3, 4, or 5.

## Import blockers

The following are hard blockers for a cutover until implemented and tested on
synthetic data:

- durable, resumable import transactions with an idempotency key and a stable
  old-account/old-listing/old-equipment to new-ID map;
- exact integer/decimal and timestamp/time-zone rules, plus password-hash
  compatibility and mandatory session invalidation/re-login;
- field-complete account, inventory, equipment/rod, market escrow, trades,
  records/codex, friends/parties, sea/voyage/quest, operator configuration,
  feedback/stats/audit and Wiki transforms;
- rejection (not automatic repair) of orphan references, duplicate IDs,
  negative/overflow values, impossible escrow, asset conservation failures,
  unsupported password/MFA formats, and ambiguous record projections;
- a field-by-field reconciliation that compares entities, references, owners,
  custody, balances, logs and asset conservation, not only row totals;
- a no-write dry run and a failed-import rollback drill against isolated
  PostgreSQL, followed by backup/WAL/PITR and post-restore reconciliation;
- a cutover state machine that guarantees one write authority and defines the
  two rollback cases: before Go creates new assets, and after Go creates new
  assets (the latter requires forward/incremental preservation or an explicit
  non-rollback boundary).

## Verification performed

The following tests pass on this worktree:

```text
go test ./cmd/import-legacy ./internal/legacy
ok fishing.local/server/cmd/import-legacy
ok fishing.local/server/internal/legacy
```

These are scanner unit tests only. They do not constitute a database import,
permission, backup/recovery or switch-over acceptance.

## Follow-up implementation review

After the audit point, the worktree gained `internal/migration/importer.go`,
`cmd/import-legacy --mode import|reconcile`, migration `0028_legacy_import.sql`
and synthetic fixtures. Those changes are useful rehearsal scaffolding, but
the following checks remain release blockers until their tests and evidence are
present:

- `wiki.db`/WAL files are currently staged as opaque entities; no SQLite
  `integrity_check`, backup/WAL pairing check, or JSON-to-SQLite row/revision
  comparison is performed.
- The account writer covers only a subset of the account object. Trades,
  social/party, sea/voyage/quest, records/catch projections, operator config,
  feedback/stats/audit and other fields must either gain explicit writers or
  produce a persisted blocking gap. Unknown fields must never be silently
  dropped.
- The catalog and equipment/rod writers require a complete item-definition
  source. A missing definition or ambiguous legacy component must stop the
  transaction; inferring a kind from an item name is not a migration rule.
- The synthetic fixture intentionally uses account filenames (`alice`, `bob`)
  that differ from payload IDs (`legacy-u-1001`, `legacy-u-2002`). The ledger
  must retain both aliases and resolve references through the payload ID map;
  resolving only the filename is an identity-loss bug.
- Failure/retry evidence must leave a durable `failed` run and staged payloads
  after rollback. A first-run transaction that rolls back its own run row is
  not an auditable failure or a resumable checkpoint.
- Reconciliation must compare each entity's value, owner, references,
  custodial/escrow state, balances and asset conservation. Counts and a gap
  count alone are insufficient.
- The staging ledger intentionally retains source payloads to prevent silent
  loss. Those rows can contain password hashes, MFA material or account names;
  they require a controlled database role, encrypted backups and redacted
  operator projections. They must never be copied into ordinary reports or
  fixture commits.

The valid synthetic fixture currently produces `Scanned 14 files; 0 findings`
from the scanner, while the blocked variant produces two findings and exit
code 1. The former is deliberately not an import pass; it demonstrates why
scanner readiness and field-complete migration acceptance are separate gates.
