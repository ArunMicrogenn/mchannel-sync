-- mchannel-sync: how the PMS side writes inventory and rates, and reads bookings.
-- Connect to database mchannel_sync (tables are in schema mchannel).
-- Hotel = PMS hotel id given at pairing (e.g. 'H001'). Room / rate plan = PMS codes
-- from the pairing mapping (e.g. 'RT-1', 'RT-1|EP'); see: mchannel-sync show H001
-- The service sends every change within PUSH_INTERVAL_SECONDS (15 s).

SET search_path = mchannel;

-- 1. Free rooms (always the recalculated number, not +1 / -1)
SELECT set_availability('H001', 'RT-1', '2026-11-20', '2026-11-20', 4);      -- one day
SELECT set_availability('H001', 'RT-1', '2026-11-16', '2027-11-15', 10);     -- 365 days at onboarding

-- 2. Prices (only sent when the hotel's rate_source = pms)
SELECT set_rate('H001', 'RT-1|EP', '2026-12-01', '2026-12-31', 3500);        -- per-room plan
SELECT set_rate('H001', 'RT-1|CP', '2026-12-01', '2026-12-31', 3000, 1);     -- per-person plan, 1 guest
SELECT set_rate('H001', 'RT-1|CP', '2026-12-01', '2026-12-31', 3500, 2);     -- 2 guests

-- 3. Restrictions (only the ones you pass change)
SELECT set_restrictions('H001', 'RT-1|EP', '2026-12-24', '2026-12-26', p_min_stay_arrival => 2);
SELECT set_restrictions('H001', 'RT-1|EP', '2026-12-31', '2026-12-31', p_stop_sell => true);
SELECT set_restrictions('H001', 'RT-1|EP', '2026-12-31', '2026-12-31', p_stop_sell => false);

-- Plain INSERT / UPDATE works too (property_id and the PMS code are filled in):
INSERT INTO room_inventory (room_type_id, stay_date, availability)
VALUES (room_type_for(property_for('H001'), 'RT-1'), '2026-11-21', 6)
ON CONFLICT (room_type_id, stay_date) DO UPDATE SET availability = EXCLUDED.availability;

-- What is waiting / what failed
SELECT stay_date, availability, version > pushed_version AS waiting, pushed_at, push_error
FROM room_inventory WHERE stay_date >= current_date ORDER BY room_type_id, stay_date LIMIT 50;

-- 4. Bookings fetched from M-Channel
SELECT pms_booking_id, unique_id, ota_name, status, arrival_date, departure_date,
       guest_first_name, guest_last_name, room_count, amount, currency, ack_status
FROM bookings ORDER BY updated_at DESC LIMIT 20;

-- rooms and nightly prices of one booking
SELECT r.room_index, r.pms_room_type_ref, r.pms_rate_plan_ref, r.checkin_date, r.checkout_date,
       n.stay_date, n.amount
FROM booking_rooms r JOIN booking_room_nights n ON n.booking_room_id = r.id
WHERE r.booking_id = '<booking id>' ORDER BY r.room_index, n.stay_date;

-- new or changed since the PMS last looked
SELECT * FROM bookings WHERE updated_at > now() - interval '15 minutes';

-- 5. A booking the hotel cannot take (room full): tell M-Channel / the OTA
SELECT ack_booking('<booking id>', 'failed', 'No availability: Standard Room on 2026-11-21, 0 free');
-- With ACK_MODE=hold the PMS confirms each booking itself:
SELECT ack_booking('<booking id>', 'imported', p_pms_booking_no => 'RES-1042');
