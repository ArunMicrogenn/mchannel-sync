# mchannel-sync

A background sync service between **M-Channel** (Microgenn channel manager, PMS Integration API
contract `mchannel-v1`, version **1.3.0**) and **PostgreSQL** on the VPS. It does two things:

| Direction | What | How |
|---|---|---|
| M-Channel → Postgres | **Bookings** (new, modified, cancelled) | Fetched every 2 minutes (`GET /bookings`), plus the signed webhook that M-Channel requires at pairing. Every booking is stored and then acked. |
| Postgres → M-Channel | **Room inventory, rates, restrictions** | The PMS side writes them into Postgres. The service sends every change within 15 seconds (`POST /ari`). |

```
 M-Channel ── bookings (fetch every 2 min + webhook) ──▶ mchannel-sync ──▶ PostgreSQL mchannel_sync
           ◀── ack ─────────────────────────────────── (PM2, :3200)  ◀── room_inventory / room_rates /
           ◀── POST /ari (changed rows only) ─────────                     rate_restrictions (PMS writes)
```

There is no REST API. The only public URL is the webhook (`https://<domain>/mchannel/webhook/…`) behind nginx.

## How it follows the spec

- **Pairing (4):** `mchannel-sync pair` claims the code. The API key and webhook secret are stored with AES-256-GCM encryption, and the mapping is stored too.
- **Setup (5):** every 6 hours it reads room types, rate plans and `ari_source` / `rate_source`.
- **Bookings (7, 8):**
  - The webhook checks the signature with HMAC-SHA256 (constant-time compare), refuses timestamps more than 300 s off, and answers 401 to a bad signature without saving anything.
  - Imports are deduplicated by event id and idempotent on `revision_id`. A revision older than the one already stored is ignored, using `revision_seq`.
  - Every revision is acked after the database commit. A Re-send from M-Channel is acked again.
  - The fetch every 2 minutes, plus an `only_unacked` sweep, picks up anything the webhook missed.
- **ARI push (6):**
  - Only rows that changed are sent. A trigger gives each real change a new `version`, so writing the same value again sends nothing.
  - Consecutive days with the same value are merged into one date range.
  - Past dates are skipped.
  - Only the parts the hotel owns are sent: rooms and restrictions when `ari_source = pms`, prices when `rate_source = pms`. The rest stays in Postgres and the hotel gets an alert.
  - Batches go out one at a time per hotel. A retry after 429, 5xx or a network error reuses the same `idempotency_key`. A 4xx (400, 401, 403, 404, 409, 422) is never retried; those rows keep the error.
  - `push-full` sends every future row as one `full` sync, at most once a day.

## Install on the VPS (Ubuntu, as root)

1. Add a DNS **A record** `mchannel.mhms.cloud → 72.61.240.34`.
2. Put the code on the server, either by cloning the `mchannel-sync` branch or by unzipping the bundle. Then run:

```bash
bash deploy/install.sh mchannel.mhms.cloud
```

The installer:

- checks Node ≥ 18.17 and PM2, and creates the system user `mchannel`;
- writes `/etc/mchannel-sync/mchannel-sync.env` with a random `ENCRYPTION_KEY` and database password. This happens on the first run only; the file is **never rewritten**;
- creates the Postgres role and database `mchannel_sync`, with `CONNECT` revoked from other roles;
- installs to `/var/www/mchannel-sync`, migrates the database, and starts PM2 app `mchannel-sync` on `127.0.0.1:3200`;
- creates an nginx site that exposes only `/mchannel/webhook/`, and gets the SSL certificate with certbot.

To update, get the new code and run `bash deploy/install.sh` again. Settings and data stay.
**Keep a copy of `ENCRYPTION_KEY`.** Without it every hotel has to be paired again.

## Pair a hotel

1. In M-Channel, open **Connect a PMS**, pick the hotel and copy the code (`MCH-XXXX-XXXX`). The code is valid for 30 minutes and works once.
2. Copy `docs/hotel.example.json`, then fill in the hotel and its PMS room types and tariffs. For mode `existing`, names must match M-Channel's room types, and rate plan names must match inside each room type.
3. Run `mchannel-sync pair --code MCH-XXXX-XXXX --hotel /root/hotel.json --env staging`

The output shows the property id, the mapping and anything `unmatched`. Bookings start being fetched straight away.
Once staging passes the go-live checklist, pair again with `--env production` and a production code.

## Writing inventory and rates (PMS side)

See `docs/sql-examples.sql`. In short:

```sql
SELECT mchannel.set_availability('H001', 'RT-1', '2026-11-20', '2026-11-20', 4);
SELECT mchannel.set_rate('H001', 'RT-1|EP', '2026-12-01', '2026-12-31', 3500);
SELECT mchannel.set_restrictions('H001', 'RT-1|EP', '2026-12-24', '2026-12-26', p_min_stay_arrival => 2);
```

Always write the **recalculated number of free rooms**, every time it changes in the PMS (booking, cancellation,
room move, block). Load 365 days at onboarding. You can also INSERT into or UPDATE
`room_inventory`, `room_rates` and `rate_restrictions` directly.

## Commands

```
mchannel-sync list | show <hotel>
mchannel-sync fetch <hotel|all>                 fetch bookings now
mchannel-sync bookings <hotel>                  stored bookings
mchannel-sync ack <booking-id> failed "<reason>"
mchannel-sync set-availability <hotel> <room> <from> <to> <n>
mchannel-sync set-rate <hotel> <rate plan> <from> <to> <price> [occupancy]
mchannel-sync inventory <hotel> [from] [to]     with state waiting / sent / error
mchannel-sync rates <hotel> [from] [to]
mchannel-sync pending <hotel>                   rows waiting + recent push batches
mchannel-sync push <hotel|all> | push-full <hotel> [--force]
mchannel-sync remote-ari <hotel> [from] [to]    what M-Channel holds (read only)
mchannel-sync pairing-status | remote-health | sync-log <hotel>
pm2 logs mchannel-sync
```

## Tables (schema `mchannel`)

| Table | Contents |
|---|---|
| `properties`, `property_channels`, `room_types`, `rate_plans`, `mappings` | Paired hotels (encrypted key and secret), OTA connections, setup, PMS code ↔ M-Channel id |
| `room_inventory` | **Input:** free rooms per room type per date |
| `room_rates` | **Input:** price per rate plan per date per occupancy (0 = per room) |
| `rate_restrictions` | **Input:** min/max stay, CTA, CTD and stop sell per rate plan per date |
| `ari_history` | Old → new value for every change |
| `ari_batches` | Every push: body, idempotency key, M-Channel's answer |
| `bookings`, `booking_rooms`, `booking_room_nights`, `booking_revisions` | **Output:** fetched bookings, rooms, nightly prices, every revision and its ack |
| `webhook_events`, `alerts`, `sync_runs` | Logs, and things for the hotel to fix |

## Settings (`/etc/mchannel-sync/mchannel-sync.env`)

| Setting | Default | Meaning |
|---|---|---|
| `BOOKING_PULL_MINUTES` | 2 | How often bookings are fetched |
| `PUSH_INTERVAL_SECONDS` | 15 | How often changed inventory and rates are checked and sent |
| `ACK_MODE` | `auto` | `auto` acks each booking once it is in Postgres. `hold` leaves the ack to the PMS (`ack_booking`) |
| `SETUP_SYNC_HOURS` | 6 | How often room types, rate plans and ownership are re-read |
| `RETENTION_DAYS` | 90 | How long logs are kept |
| `PUBLIC_BASE_URL` | — | Webhook address given at pairing. Changing it means pairing again |

Run `pm2 restart mchannel-sync` after an edit. The server clock must be correct (NTP).

## Tests

`npm test` with `MCHANNEL_SYNC_ENV` pointing at a **throw-away** database. It runs 20 end-to-end checks
against `test/mock-mchannel.js`, covering the spec's go-live checklist.
