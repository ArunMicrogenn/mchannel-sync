'use strict';
// Hotel setup: GET /properties, /room-types, /rate-plans (spec section 5).

const db = require('../lib/db');
const { clientFor } = require('../lib/properties');
const { withRunLog } = require('./run-log');

async function syncSetup(property) {
  return withRunLog(property.id, 'setup', async () => {
    const client = clientFor(property);
    const [propsRes, rtRes, rpRes] = [
      await client.listProperties(),
      await client.roomTypes(property.id),
      await client.ratePlans(property.id),
    ];
    const remote = (propsRes.data || []).find((p) => p.id === property.id);
    if (!remote) {
      throw new Error('This API key no longer lists the property (GET /properties). Pair again if the key was revoked.');
    }
    const roomTypes = rtRes.data || [];
    const ratePlans = rpRes.data || [];
    const channels = remote.active_channels || [];

    await db.tx(async (c) => {
      await c.query(
        `UPDATE properties SET
           code = COALESCE($2, code), name = COALESCE($3, name), currency = COALESCE($4, currency),
           timezone = COALESCE($5, timezone), status = $6, ari_source = $7, rate_source = $8,
           raw = $9, setup_synced_at = now(), updated_at = now()
         WHERE id = $1`,
        [property.id, remote.code, remote.name, remote.currency, remote.timezone, remote.status,
          remote.ari_source, remote.rate_source, remote],
      );

      await c.query(
        `INSERT INTO property_channels (property_id, connection_id, ota_code, title, is_active, synced_at)
         SELECT $1, r.connection_id, r.ota_code, r.title, r.is_active, now()
         FROM jsonb_to_recordset($2::jsonb) AS r(connection_id uuid, ota_code text, title text, is_active boolean)
         WHERE r.connection_id IS NOT NULL
         ON CONFLICT (property_id, connection_id) DO UPDATE SET
           ota_code = EXCLUDED.ota_code, title = EXCLUDED.title, is_active = EXCLUDED.is_active, synced_at = now()`,
        [property.id, JSON.stringify(channels)],
      );
      await c.query(
        `DELETE FROM property_channels WHERE property_id = $1 AND NOT (connection_id = ANY($2::uuid[]))`,
        [property.id, channels.map((ch) => ch.connection_id).filter(Boolean)],
      );

      await c.query(
        `INSERT INTO room_types (id, property_id, code, title, count_of_rooms, occ_adults, occ_children,
                                 occ_infants, default_occupancy, is_active, raw, synced_at)
         SELECT r.id, $1, r.code, r.title, r.count_of_rooms, r.occ_adults, r.occ_children, r.occ_infants,
                r.default_occupancy, COALESCE(r.is_active, true), r.raw, now()
         FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, code text, title text, count_of_rooms int,
              occ_adults int, occ_children int, occ_infants int, default_occupancy int, is_active boolean, raw jsonb)
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code, title = EXCLUDED.title, count_of_rooms = EXCLUDED.count_of_rooms,
           occ_adults = EXCLUDED.occ_adults, occ_children = EXCLUDED.occ_children,
           occ_infants = EXCLUDED.occ_infants, default_occupancy = EXCLUDED.default_occupancy,
           is_active = EXCLUDED.is_active, raw = EXCLUDED.raw, synced_at = now()`,
        [property.id, JSON.stringify(roomTypes.map((r) => ({ ...r, raw: r })))],
      );
      await c.query(
        `UPDATE room_types SET is_active = false, synced_at = now()
         WHERE property_id = $1 AND NOT (id = ANY($2::uuid[])) AND is_active IS DISTINCT FROM false`,
        [property.id, roomTypes.map((r) => r.id)],
      );

      await c.query(
        `INSERT INTO rate_plans (id, property_id, room_type_id, code, title, sell_mode, rate_mode, meal_type,
                                 currency, parent_rate_plan_id, occupancies, is_active, raw, synced_at)
         SELECT r.id, $1, r.room_type_id, r.code, r.title, r.sell_mode, r.rate_mode, r.meal_type, r.currency,
                r.parent_rate_plan_id, r.occupancies, COALESCE(r.is_active, true), r.raw, now()
         FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, room_type_id uuid, code text, title text,
              sell_mode text, rate_mode text, meal_type text, currency text, parent_rate_plan_id uuid,
              occupancies jsonb, is_active boolean, raw jsonb)
         ON CONFLICT (id) DO UPDATE SET
           room_type_id = EXCLUDED.room_type_id, code = EXCLUDED.code, title = EXCLUDED.title,
           sell_mode = EXCLUDED.sell_mode, rate_mode = EXCLUDED.rate_mode, meal_type = EXCLUDED.meal_type,
           currency = EXCLUDED.currency, parent_rate_plan_id = EXCLUDED.parent_rate_plan_id,
           occupancies = EXCLUDED.occupancies, is_active = EXCLUDED.is_active, raw = EXCLUDED.raw,
           synced_at = now()`,
        [property.id, JSON.stringify(ratePlans.map((r) => ({ ...r, raw: r })))],
      );
      await c.query(
        `UPDATE rate_plans SET is_active = false, synced_at = now()
         WHERE property_id = $1 AND NOT (id = ANY($2::uuid[])) AND is_active IS DISTINCT FROM false`,
        [property.id, ratePlans.map((r) => r.id)],
      );
    });

    return {
      items: roomTypes.length + ratePlans.length,
      detail: `status=${remote.status} ari_source=${remote.ari_source} rate_source=${remote.rate_source} ` +
        `room_types=${roomTypes.length} rate_plans=${ratePlans.length} channels=${channels.length}`,
    };
  });
}

module.exports = { syncSetup };
