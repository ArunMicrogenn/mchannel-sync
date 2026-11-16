-- M-Channel sync service: initial schema (contract mchannel-v1, 1.3.0)
-- Everything lives in schema "mchannel" so it can share a database safely.

CREATE SCHEMA IF NOT EXISTS mchannel;
SET search_path = mchannel, public;

-- ---------------------------------------------------------------------------
-- Hotels (one row per paired M-Channel property) and their credentials
-- ---------------------------------------------------------------------------
CREATE TABLE properties (
  id                   uuid PRIMARY KEY,                 -- M-Channel property id
  env                  text NOT NULL CHECK (env IN ('staging','production')),
  base_url             text NOT NULL,
  pms_hotel_id         text NOT NULL,
  code                 text,
  name                 text NOT NULL,
  status               text,                             -- draft | syncing | live | paused
  ari_source           text,                             -- pms | mchannel
  rate_source          text,                             -- pms | mchannel
  currency             char(3),
  timezone             text NOT NULL DEFAULT 'Asia/Kolkata',
  pairing_mode         text,                             -- existing | new
  api_key_enc          text NOT NULL,                    -- AES-256-GCM, see src/lib/crypto.js
  webhook_secret_enc   text NOT NULL,
  webhook_token        text NOT NULL UNIQUE,             -- path segment of our webhook URL
  is_enabled           boolean NOT NULL DEFAULT true,
  raw                  jsonb,
  paired_at            timestamptz NOT NULL DEFAULT now(),
  setup_synced_at      timestamptz,
  full_push_requested  boolean NOT NULL DEFAULT false,    -- next ARI batch goes as sync_type = full
  ari_pushed_at        timestamptz,                      -- last ARI batch accepted by M-Channel
  booking_cursor       timestamptz,                      -- "since" for GET /bookings
  bookings_pulled_at   timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX properties_pms_hotel_idx ON properties(env, pms_hotel_id);

CREATE TABLE property_channels (
  property_id    uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL,
  ota_code       text,
  title          text,
  is_active      boolean,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, connection_id)
);

-- ---------------------------------------------------------------------------
-- Hotel setup
-- ---------------------------------------------------------------------------
CREATE TABLE room_types (
  id                 uuid PRIMARY KEY,                   -- M-Channel room type id
  property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code               text,
  title              text NOT NULL,
  count_of_rooms     integer,
  occ_adults         integer,
  occ_children       integer,
  occ_infants        integer,
  default_occupancy  integer,
  is_active          boolean,
  raw                jsonb,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_types_property_idx ON room_types(property_id);

CREATE TABLE rate_plans (
  id                   uuid PRIMARY KEY,                 -- M-Channel rate plan id
  property_id          uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_type_id         uuid,
  code                 text,
  title                text NOT NULL,
  sell_mode            text,                             -- per_room | per_person
  rate_mode            text,                             -- manual | derived | cascade | auto
  meal_type            text,
  currency             char(3),
  parent_rate_plan_id  uuid,
  occupancies          jsonb,
  is_active            boolean,
  raw                  jsonb,
  synced_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_plans_property_idx ON rate_plans(property_id);
CREATE INDEX rate_plans_room_type_idx ON rate_plans(room_type_id);

-- PMS code <-> M-Channel id. One row per mapping entry (rate plan may be null).
CREATE TABLE mappings (
  id                 bigserial PRIMARY KEY,
  property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  pms_room_type_ref  text NOT NULL,
  pms_rate_plan_ref  text,
  room_type_id       uuid NOT NULL,
  rate_plan_id       uuid,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mappings_uniq ON mappings(property_id, pms_room_type_ref, COALESCE(pms_rate_plan_ref, ''));

-- ---------------------------------------------------------------------------
-- Room inventory and rates: the PMS side writes them here, the service pushes
-- them to M-Channel (POST /properties/:id/ari).
-- Write rows directly, or use mchannel.set_availability / set_rate /
-- set_restrictions (end of this file), which accept PMS codes.
-- Every real change gets a new "version" from a trigger; a row is waiting to be
-- sent while version > pushed_version. Writing the same value again does not
-- create a new version, so it is not sent again.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE ari_version_seq;

CREATE TABLE room_inventory (
  property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_type_id       uuid NOT NULL,                     -- M-Channel room type id
  stay_date          date NOT NULL,
  availability       integer NOT NULL CHECK (availability >= 0),   -- free rooms (recalculated number)
  pms_room_type_ref  text,
  version            bigint NOT NULL DEFAULT 0,
  pushed_version     bigint NOT NULL DEFAULT 0,
  changed_at         timestamptz NOT NULL DEFAULT now(),
  pushed_at          timestamptz,
  push_error         text,
  PRIMARY KEY (room_type_id, stay_date)
);
CREATE INDEX room_inventory_property_date_idx ON room_inventory(property_id, stay_date);
CREATE INDEX room_inventory_pending_idx ON room_inventory(property_id, room_type_id, stay_date) WHERE version > pushed_version;

CREATE TABLE room_rates (
  property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  rate_plan_id       uuid NOT NULL,                     -- M-Channel rate plan id
  stay_date          date NOT NULL,
  occupancy          integer NOT NULL DEFAULT 0 CHECK (occupancy >= 0),  -- 0 = per-room price, 1..n = price for that many guests
  rate               numeric(12,2) NOT NULL CHECK (rate >= 0),
  pms_rate_plan_ref  text,
  version            bigint NOT NULL DEFAULT 0,
  pushed_version     bigint NOT NULL DEFAULT 0,
  changed_at         timestamptz NOT NULL DEFAULT now(),
  pushed_at          timestamptz,
  push_error         text,
  PRIMARY KEY (rate_plan_id, stay_date, occupancy)
);
CREATE INDEX room_rates_property_date_idx ON room_rates(property_id, stay_date);
CREATE INDEX room_rates_pending_idx ON room_rates(property_id, rate_plan_id, stay_date) WHERE version > pushed_version;

CREATE TABLE rate_restrictions (
  property_id          uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  rate_plan_id         uuid NOT NULL,
  stay_date            date NOT NULL,
  min_stay_arrival     integer CHECK (min_stay_arrival >= 1),
  min_stay_through     integer CHECK (min_stay_through >= 1),
  max_stay             integer CHECK (max_stay >= 0),          -- 0 removes the limit
  closed_to_arrival    boolean,
  closed_to_departure  boolean,
  stop_sell            boolean,
  pms_rate_plan_ref    text,
  version              bigint NOT NULL DEFAULT 0,
  pushed_version       bigint NOT NULL DEFAULT 0,
  changed_at           timestamptz NOT NULL DEFAULT now(),
  pushed_at            timestamptz,
  push_error           text,
  PRIMARY KEY (rate_plan_id, stay_date),
  CHECK (num_nonnulls(min_stay_arrival, min_stay_through, max_stay, closed_to_arrival,
                      closed_to_departure, stop_sell) > 0)
);
CREATE INDEX rate_restrictions_property_date_idx ON rate_restrictions(property_id, stay_date);
CREATE INDEX rate_restrictions_pending_idx ON rate_restrictions(property_id, rate_plan_id, stay_date) WHERE version > pushed_version;

-- Columns that are bookkeeping, not data (ignored when deciding "changed").
CREATE FUNCTION ari_meta_columns() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['version', 'pushed_version', 'changed_at', 'pushed_at', 'push_error',
               'pms_room_type_ref', 'pms_rate_plan_ref', 'property_id']
$$;

-- Fill property_id / PMS code from the hotel setup when the writer left them out.
CREATE FUNCTION trg_room_inventory_fill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.property_id IS NULL OR NEW.pms_room_type_ref IS NULL THEN
    SELECT COALESCE(NEW.property_id, rt.property_id),
           COALESCE(NEW.pms_room_type_ref,
                    (SELECT m.pms_room_type_ref FROM mchannel.mappings m
                     WHERE m.room_type_id = rt.id ORDER BY m.pms_rate_plan_ref NULLS FIRST LIMIT 1))
      INTO NEW.property_id, NEW.pms_room_type_ref
      FROM mchannel.room_types rt WHERE rt.id = NEW.room_type_id;
  END IF;
  IF NEW.property_id IS NULL THEN
    RAISE EXCEPTION 'mchannel: unknown room_type_id % (run "mchannel-sync sync <hotel> setup" first?)', NEW.room_type_id;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION trg_rate_fill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.property_id IS NULL OR NEW.pms_rate_plan_ref IS NULL THEN
    SELECT COALESCE(NEW.property_id, rp.property_id),
           COALESCE(NEW.pms_rate_plan_ref,
                    (SELECT m.pms_rate_plan_ref FROM mchannel.mappings m
                     WHERE m.rate_plan_id = rp.id LIMIT 1))
      INTO NEW.property_id, NEW.pms_rate_plan_ref
      FROM mchannel.rate_plans rp WHERE rp.id = NEW.rate_plan_id;
  END IF;
  IF NEW.property_id IS NULL THEN
    RAISE EXCEPTION 'mchannel: unknown rate_plan_id % (run "mchannel-sync sync <hotel> setup" first?)', NEW.rate_plan_id;
  END IF;
  RETURN NEW;
END $$;

-- New version on every real data change.
CREATE FUNCTION trg_ari_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR (to_jsonb(NEW) - mchannel.ari_meta_columns()) IS DISTINCT FROM (to_jsonb(OLD) - mchannel.ari_meta_columns()) THEN
    NEW.version := nextval('mchannel.ari_version_seq');
    NEW.changed_at := now();
    NEW.push_error := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE ari_history (
  id           bigserial PRIMARY KEY,
  property_id  uuid NOT NULL,
  kind         text NOT NULL,          -- availability | rate | restriction
  ref_id       uuid NOT NULL,          -- room_type_id or rate_plan_id
  stay_date    date NOT NULL,
  occupancy    integer,
  old_values   jsonb,
  new_values   jsonb NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ari_history_idx ON ari_history(ref_id, stay_date, recorded_at);

CREATE FUNCTION trg_ari_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  meta text[] := mchannel.ari_meta_columns() || ARRAY['room_type_id', 'rate_plan_id', 'stay_date', 'occupancy'];
  j jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN
    RETURN NEW;
  END IF;
  INSERT INTO mchannel.ari_history (property_id, kind, ref_id, stay_date, occupancy, old_values, new_values)
  VALUES (NEW.property_id,
          CASE TG_TABLE_NAME WHEN 'room_inventory' THEN 'availability' WHEN 'room_rates' THEN 'rate' ELSE 'restriction' END,
          COALESCE(j->>'room_type_id', j->>'rate_plan_id')::uuid, NEW.stay_date, (j->>'occupancy')::int,
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) - meta END, j - meta);
  RETURN NEW;
END $$;

CREATE TRIGGER a_fill BEFORE INSERT OR UPDATE ON room_inventory FOR EACH ROW EXECUTE FUNCTION trg_room_inventory_fill();
CREATE TRIGGER b_version BEFORE INSERT OR UPDATE ON room_inventory FOR EACH ROW EXECUTE FUNCTION trg_ari_version();
CREATE TRIGGER c_history AFTER INSERT OR UPDATE ON room_inventory FOR EACH ROW EXECUTE FUNCTION trg_ari_history();

CREATE TRIGGER a_fill BEFORE INSERT OR UPDATE ON room_rates FOR EACH ROW EXECUTE FUNCTION trg_rate_fill();
CREATE TRIGGER b_version BEFORE INSERT OR UPDATE ON room_rates FOR EACH ROW EXECUTE FUNCTION trg_ari_version();
CREATE TRIGGER c_history AFTER INSERT OR UPDATE ON room_rates FOR EACH ROW EXECUTE FUNCTION trg_ari_history();

CREATE TRIGGER a_fill BEFORE INSERT OR UPDATE ON rate_restrictions FOR EACH ROW EXECUTE FUNCTION trg_rate_fill();
CREATE TRIGGER b_version BEFORE INSERT OR UPDATE ON rate_restrictions FOR EACH ROW EXECUTE FUNCTION trg_ari_version();
CREATE TRIGGER c_history AFTER INSERT OR UPDATE ON rate_restrictions FOR EACH ROW EXECUTE FUNCTION trg_ari_history();

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
  id                        uuid PRIMARY KEY,            -- M-Channel booking id (stable across revisions)
  pms_booking_id            bigserial UNIQUE,            -- our id, sent as pms_booking_id in the ack
  pms_booking_no            text,                        -- number the hotel sees in its PMS (set via the API)
  external_booking_id       text,                        -- the PMS's own id, when a PMS imports it (ACK_MODE=hold)
  property_id               uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  revision_id               uuid NOT NULL,
  revision_seq              integer NOT NULL,
  status                    text NOT NULL,               -- new | modified | cancelled
  ota_code                  text,
  ota_name                  text,
  secondary_ota_name        text,
  ota_reservation_code      text,
  unique_id                 text,
  arrival_date              date,
  departure_date            date,
  arrival_time              text,
  booked_at                 timestamptz,
  received_at               timestamptz,
  currency                  char(3),
  amount                    numeric(14,2),
  ota_commission            numeric(14,2),
  guest_first_name          text,
  guest_last_name           text,
  guest_email               text,
  guest_phone               text,
  guest_country             text,
  guest_city                text,
  guest                     jsonb,
  adults                    integer,
  children                  integer,
  infants                   integer,
  room_count                integer,
  payment_collect           text,                        -- property | ota | null
  payment_type              text,
  payment                   jsonb,
  notes                     text,
  cancellation_policy_text  text,
  services                  jsonb,
  is_unmapped               boolean NOT NULL DEFAULT false,
  raw                       jsonb NOT NULL,
  first_seen_at             timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  cancelled_at              timestamptz,
  ack_status                text NOT NULL DEFAULT 'pending',   -- pending | hold | acked | failed
  acked_revision_id         uuid,
  acked_at                  timestamptz
);
CREATE INDEX bookings_property_arrival_idx ON bookings(property_id, arrival_date);
CREATE INDEX bookings_property_status_idx ON bookings(property_id, status);
CREATE INDEX bookings_unique_id_idx ON bookings(unique_id);

CREATE TABLE booking_rooms (
  id                  bigserial PRIMARY KEY,
  booking_id          uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  property_id         uuid NOT NULL,
  room_index          integer NOT NULL,
  room_type_id        uuid,
  rate_plan_id        uuid,
  pms_room_type_ref   text,
  pms_rate_plan_ref   text,
  ota_room_code       text,
  ota_rate_code       text,
  ota_room_unique_id  text,
  checkin_date        date,
  checkout_date       date,
  adults              integer,
  children            integer,
  infants             integer,
  guests              jsonb,
  amount              numeric(14,2),
  taxes               jsonb,
  services            jsonb,
  meal_plan           text,
  is_cancelled        boolean NOT NULL DEFAULT false,
  UNIQUE (booking_id, room_index)
);
CREATE INDEX booking_rooms_room_type_idx ON booking_rooms(room_type_id, checkin_date);

CREATE TABLE booking_room_nights (
  booking_room_id  bigint NOT NULL REFERENCES booking_rooms(id) ON DELETE CASCADE,
  booking_id       uuid NOT NULL,
  property_id      uuid NOT NULL,
  room_type_id     uuid,
  stay_date        date NOT NULL,
  amount           numeric(14,2),
  PRIMARY KEY (booking_room_id, stay_date)
);
CREATE INDEX booking_room_nights_date_idx ON booking_room_nights(property_id, stay_date);

-- Every revision we have seen, with its raw JSON and the ack we owe M-Channel.
CREATE TABLE booking_revisions (
  revision_id      uuid PRIMARY KEY,
  booking_id       uuid NOT NULL,
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  revision_seq     integer NOT NULL,
  status           text NOT NULL,
  source           text NOT NULL,                 -- webhook | pull
  event_id         uuid,
  applied          boolean NOT NULL,              -- false when an older revision arrived late
  payload          jsonb NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  ack_status       text NOT NULL DEFAULT 'pending',  -- pending | sending | sent | error | failed | skipped | hold
  ack_result       text,                          -- imported | updated | cancelled | failed
  failure_reason   text,
  ack_attempts     integer NOT NULL DEFAULT 0,
  ack_next_at      timestamptz NOT NULL DEFAULT now(),
  ack_error        text,
  acked_at         timestamptz
);
CREATE INDEX booking_revisions_booking_idx ON booking_revisions(booking_id, revision_seq);
CREATE INDEX booking_revisions_ack_idx ON booking_revisions(ack_status, ack_next_at);

-- ---------------------------------------------------------------------------
-- Webhook log, alerts
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  event_id      uuid PRIMARY KEY,
  property_id   uuid,
  event         text NOT NULL,
  occurred_at   timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  result        text,
  payload       jsonb NOT NULL
);
CREATE INDEX webhook_events_property_idx ON webhook_events(property_id, received_at);

CREATE TABLE alerts (
  id           bigserial PRIMARY KEY,
  property_id  uuid,
  kind         text NOT NULL,      -- ari.rejected | channel.disconnected | mapping.required | ari_push_failed | ack_failed | booking_unmapped
  message      text,
  data         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX alerts_open_idx ON alerts(property_id, created_at) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- ARI push log: one row per POST /ari. "rows" remembers which table rows (and
-- which version of each) the batch carries; the idempotency_key is reused on
-- every retry of the same batch.
-- ---------------------------------------------------------------------------
CREATE TABLE ari_batches (
  id               bigserial PRIMARY KEY,
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  idempotency_key  text NOT NULL UNIQUE,
  sync_type        text NOT NULL CHECK (sync_type IN ('delta','full')),
  body             jsonb NOT NULL,
  rows             jsonb NOT NULL,
  item_count       integer NOT NULL,
  row_count        integer NOT NULL,
  status           text NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  http_status      integer,
  mc_batch_id      uuid,
  response         jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX ari_batches_pending_idx ON ari_batches(property_id, id) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Job log
-- ---------------------------------------------------------------------------
CREATE TABLE sync_runs (
  id           bigserial PRIMARY KEY,
  property_id  uuid,
  job          text NOT NULL,       -- setup | bookings | ari_push
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  ok           boolean,
  items        integer,
  detail       text
);
CREATE INDEX sync_runs_property_idx ON sync_runs(property_id, job, started_at DESC);

-- ---------------------------------------------------------------------------
-- Helper functions for the PMS side. <hotel> = PMS hotel id, M-Channel code or
-- property id. <room>/<rate plan> = PMS code from the pairing mapping
-- (e.g. 'RT-1', 'RT-1|EP'), M-Channel code, title or id.
--   SELECT mchannel.set_availability('H001', 'RT-1', '2026-11-20', '2026-11-20', 4);
--   SELECT mchannel.set_rate('H001', 'RT-1|EP', '2026-12-01', '2026-12-31', 3500);
--   SELECT mchannel.set_rate('H001', 'RT-1|CP', '2026-12-01', '2026-12-31', 3000, 1);  -- 1 guest
--   SELECT mchannel.set_restrictions('H001', 'RT-1|EP', '2026-12-24', '2026-12-26', p_min_stay_arrival => 2);
-- Each returns the number of days written.
-- ---------------------------------------------------------------------------
CREATE FUNCTION property_for(p_hotel text) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE
  v uuid;
BEGIN
  SELECT id INTO v FROM mchannel.properties
  WHERE is_enabled AND (id::text = p_hotel OR pms_hotel_id = p_hotel OR lower(code) = lower(p_hotel))
  ORDER BY paired_at DESC LIMIT 1;
  IF v IS NULL THEN
    RAISE EXCEPTION 'mchannel: no paired hotel "%"', p_hotel;
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION room_type_for(p_property uuid, p_room text) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE
  v uuid;
BEGIN
  SELECT room_type_id INTO v FROM mchannel.mappings
  WHERE property_id = p_property AND pms_room_type_ref = p_room LIMIT 1;
  IF v IS NULL THEN
    SELECT id INTO v FROM mchannel.room_types
    WHERE property_id = p_property AND (id::text = p_room OR code = p_room OR lower(title) = lower(p_room))
    ORDER BY is_active DESC NULLS LAST LIMIT 1;
  END IF;
  IF v IS NULL THEN
    RAISE EXCEPTION 'mchannel: room type "%" is not mapped for this hotel', p_room;
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION rate_plan_for(p_property uuid, p_rate_plan text) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE
  v uuid;
BEGIN
  SELECT rate_plan_id INTO v FROM mchannel.mappings
  WHERE property_id = p_property AND pms_rate_plan_ref = p_rate_plan AND rate_plan_id IS NOT NULL LIMIT 1;
  IF v IS NULL THEN
    SELECT id INTO v FROM mchannel.rate_plans
    WHERE property_id = p_property AND (id::text = p_rate_plan OR code = p_rate_plan)
    ORDER BY is_active DESC NULLS LAST LIMIT 1;
  END IF;
  IF v IS NULL THEN
    RAISE EXCEPTION 'mchannel: rate plan "%" is not mapped for this hotel', p_rate_plan;
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION set_availability(p_hotel text, p_room text, p_from date, p_to date, p_availability integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  pid uuid := mchannel.property_for(p_hotel);
  rt uuid := mchannel.room_type_for(pid, p_room);
  n integer;
BEGIN
  IF p_to < p_from THEN RAISE EXCEPTION 'mchannel: date_to is before date_from'; END IF;
  INSERT INTO mchannel.room_inventory (property_id, room_type_id, stay_date, availability)
  SELECT pid, rt, d::date, p_availability FROM generate_series(p_from, p_to, interval '1 day') AS d
  ON CONFLICT (room_type_id, stay_date) DO UPDATE SET availability = EXCLUDED.availability;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION set_rate(p_hotel text, p_rate_plan text, p_from date, p_to date, p_rate numeric,
                         p_occupancy integer DEFAULT 0)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  pid uuid := mchannel.property_for(p_hotel);
  rp uuid := mchannel.rate_plan_for(pid, p_rate_plan);
  n integer;
BEGIN
  IF p_to < p_from THEN RAISE EXCEPTION 'mchannel: date_to is before date_from'; END IF;
  INSERT INTO mchannel.room_rates (property_id, rate_plan_id, stay_date, occupancy, rate)
  SELECT pid, rp, d::date, p_occupancy, p_rate FROM generate_series(p_from, p_to, interval '1 day') AS d
  ON CONFLICT (rate_plan_id, stay_date, occupancy) DO UPDATE SET rate = EXCLUDED.rate;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Only the restrictions you pass are changed; the others keep their value.
CREATE FUNCTION set_restrictions(p_hotel text, p_rate_plan text, p_from date, p_to date,
                                 p_min_stay_arrival integer DEFAULT NULL, p_min_stay_through integer DEFAULT NULL,
                                 p_max_stay integer DEFAULT NULL, p_closed_to_arrival boolean DEFAULT NULL,
                                 p_closed_to_departure boolean DEFAULT NULL, p_stop_sell boolean DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  pid uuid := mchannel.property_for(p_hotel);
  rp uuid := mchannel.rate_plan_for(pid, p_rate_plan);
  n integer;
BEGIN
  IF p_to < p_from THEN RAISE EXCEPTION 'mchannel: date_to is before date_from'; END IF;
  IF num_nonnulls(p_min_stay_arrival, p_min_stay_through, p_max_stay, p_closed_to_arrival,
                  p_closed_to_departure, p_stop_sell) = 0 THEN
    RAISE EXCEPTION 'mchannel: give at least one restriction';
  END IF;
  INSERT INTO mchannel.rate_restrictions (property_id, rate_plan_id, stay_date, min_stay_arrival, min_stay_through,
                                          max_stay, closed_to_arrival, closed_to_departure, stop_sell)
  SELECT pid, rp, d::date, p_min_stay_arrival, p_min_stay_through, p_max_stay, p_closed_to_arrival,
         p_closed_to_departure, p_stop_sell
  FROM generate_series(p_from, p_to, interval '1 day') AS d
  ON CONFLICT (rate_plan_id, stay_date) DO UPDATE SET
    min_stay_arrival    = COALESCE(EXCLUDED.min_stay_arrival, rate_restrictions.min_stay_arrival),
    min_stay_through    = COALESCE(EXCLUDED.min_stay_through, rate_restrictions.min_stay_through),
    max_stay            = COALESCE(EXCLUDED.max_stay, rate_restrictions.max_stay),
    closed_to_arrival   = COALESCE(EXCLUDED.closed_to_arrival, rate_restrictions.closed_to_arrival),
    closed_to_departure = COALESCE(EXCLUDED.closed_to_departure, rate_restrictions.closed_to_departure),
    stop_sell           = COALESCE(EXCLUDED.stop_sell, rate_restrictions.stop_sell);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Ack a booking from the PMS side (needed with ACK_MODE=hold, or to report that
-- a booking could not be taken). result: imported | updated | cancelled | failed
--   SELECT mchannel.ack_booking('<booking id>', 'imported', p_pms_booking_no => 'RES-1042');
--   SELECT mchannel.ack_booking('<booking id>', 'failed', 'No availability: Standard Room on 2026-11-21');
CREATE FUNCTION ack_booking(p_booking_id uuid, p_result text, p_failure_reason text DEFAULT NULL,
                            p_pms_booking_no text DEFAULT NULL, p_pms_booking_id text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  rev uuid;
BEGIN
  IF p_result NOT IN ('imported', 'updated', 'cancelled', 'failed') THEN
    RAISE EXCEPTION 'mchannel: result must be imported, updated, cancelled or failed';
  END IF;
  IF p_result = 'failed' AND coalesce(trim(p_failure_reason), '') = '' THEN
    RAISE EXCEPTION 'mchannel: failure_reason is required when result = failed';
  END IF;
  UPDATE mchannel.bookings
     SET pms_booking_no = COALESCE(p_pms_booking_no, pms_booking_no),
         external_booking_id = COALESCE(p_pms_booking_id, external_booking_id)
   WHERE id = p_booking_id
  RETURNING revision_id INTO rev;
  IF rev IS NULL THEN
    RAISE EXCEPTION 'mchannel: unknown booking %', p_booking_id;
  END IF;
  UPDATE mchannel.booking_revisions
     SET ack_status = 'pending', ack_result = p_result, ack_next_at = now(), ack_attempts = 0, ack_error = NULL,
         failure_reason = CASE WHEN p_result = 'failed' THEN left(p_failure_reason, 500) END
   WHERE revision_id = rev;
  RETURN 'queued ack for revision ' || rev;
END $$;
