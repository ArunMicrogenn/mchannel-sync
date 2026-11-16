#!/usr/bin/env bash
# mchannel-sync installer / updater for an Ubuntu VPS (run as root).
#
#   bash deploy/install.sh mchannel.mhms.cloud      first install, with nginx + SSL for that domain
#   bash deploy/install.sh                          update the code (keeps every setting)
#
# Safe to run again: it never rewrites /etc/mchannel-sync/mchannel-sync.env
# (that file holds ENCRYPTION_KEY - losing it means pairing every hotel again).
#
# Optional environment:
#   APP_DIR=/var/www/mchannel-sync   PORT=3200   APP_USER=mchannel
#   DB_NAME=mchannel_sync  DB_USER=mchannel_sync  CERTBOT_EMAIL=you@example.com
#   SKIP_NGINX=1  (no nginx / certbot changes)

set -euo pipefail

DOMAIN="${1:-}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/var/www/mchannel-sync}"
PORT="${PORT:-3200}"
APP_USER="${APP_USER:-mchannel}"
DB_NAME="${DB_NAME:-mchannel_sync}"
DB_USER="${DB_USER:-mchannel_sync}"
ENV_DIR=/etc/mchannel-sync
ENV_FILE="$ENV_DIR/mchannel-sync.env"
DATA_DIR=/var/lib/mchannel-sync
NGINX_SITE=/etc/nginx/sites-available/mchannel-sync.conf

ok=0; warn=0
step()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
good()  { printf '  \033[32mOK\033[0m   %s\n' "$*"; ok=$((ok+1)); }
note()  { printf '  \033[33mNOTE\033[0m %s\n' "$*"; warn=$((warn+1)); }
die()   { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash deploy/install.sh ...)"
[ -f "$SRC_DIR/src/server.js" ] || die "run this from the unpacked mchannel-sync folder"
VERSION="$(grep -m1 '"version"' "$SRC_DIR/package.json" | sed -E 's/.*"([0-9.]+)".*/\1/')"
echo "mchannel-sync $VERSION installer  (source: $SRC_DIR, app: $APP_DIR, port: $PORT)"

# ---------------------------------------------------------------------------
step "Node.js and PM2"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  minor="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$major" -gt 18 ] || { [ "$major" -eq 18 ] && [ "$minor" -ge 17 ]; }; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  echo "  installing Node.js 20 (NodeSource)"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
good "node $(node -v)"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2 >/dev/null 2>&1 || die "could not install pm2"
fi
good "pm2 $(pm2 -v 2>/dev/null | tail -1)"

# ---------------------------------------------------------------------------
step "Service user and folders"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
  good "created system user $APP_USER"
else
  good "user $APP_USER exists"
fi
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
install -d -m 750 -o root -g "$APP_USER" "$ENV_DIR"
mkdir -p "$APP_DIR"

# ---------------------------------------------------------------------------
step "Settings file $ENV_FILE"
NEW_ENV=0
DB_PASS=""
if [ -f "$ENV_FILE" ]; then
  good "kept existing settings (not rewritten)"
  if [ -n "$DOMAIN" ] && ! grep -q "^PUBLIC_BASE_URL=https://$DOMAIN\$" "$ENV_FILE"; then
    note "PUBLIC_BASE_URL in $ENV_FILE is not https://$DOMAIN - edit it by hand if the domain changed (hotels then need pairing again)"
  fi
else
  [ -n "$DOMAIN" ] || die "first install needs the public domain: bash deploy/install.sh mchannel.example.com"
  DB_PASS="$(openssl rand -hex 24)"
  umask 027
  cat > "$ENV_FILE" <<EOF
# mchannel-sync settings - created $(date -u +%Y-%m-%dT%H:%M:%SZ) by install.sh
# KEEP A SAFE COPY OF ENCRYPTION_KEY: it decrypts every hotel's M-Channel API key.
HOST=127.0.0.1
PORT=$PORT
DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
DB_SCHEMA=mchannel
PUBLIC_BASE_URL=https://$DOMAIN
ENCRYPTION_KEY=$(openssl rand -hex 32)
PMS_NAME=Microgenn M-Channel Sync
DATA_DIR=$DATA_DIR

# auto = ack each booking after it is saved in Postgres
# hold = save it, and let the PMS ack it with SELECT mchannel.ack_booking(...)
ACK_MODE=auto

# Schedules
BOOKING_PULL_MINUTES=2
BOOKING_BACKFILL_DAYS=30
PUSH_INTERVAL_SECONDS=15
SETUP_SYNC_HOURS=6
RETENTION_DAYS=90
LOG_LEVEL=info

# Endpoints (change only if Microgenn gives you other ones)
MCHANNEL_STAGING_URL=https://stagcm.microgenn.com
MCHANNEL_PRODUCTION_URL=https://cmlive.microgenn.com
EOF
  umask 022
  NEW_ENV=1
  good "created with a new ENCRYPTION_KEY and database password"
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
envval() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-; }
PORT="$(envval PORT)"; PORT="${PORT:-3200}"

# ---------------------------------------------------------------------------
step "PostgreSQL database $DB_NAME"
if ! command -v psql >/dev/null 2>&1; then
  echo "  installing PostgreSQL"
  apt-get update -qq && apt-get install -y -qq postgresql >/dev/null
  systemctl enable --now postgresql >/dev/null 2>&1 || true
fi
if sudo -u postgres psql -qAtc 'SELECT 1' >/dev/null 2>&1; then
  role_exists="$(sudo -u postgres psql -qAtc "SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER'")"
  if [ "$role_exists" != "1" ]; then
    [ -n "$DB_PASS" ] || die "role $DB_USER is missing but $ENV_FILE already exists. Create the role with the password from DATABASE_URL, or remove the env file and run again."
    sudo -u postgres psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'" >/dev/null
    good "created role $DB_USER"
  elif [ "$NEW_ENV" -eq 1 ]; then
    sudo -u postgres psql -qc "ALTER ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'" >/dev/null
    good "role $DB_USER exists - password set to the new one in $ENV_FILE"
  else
    good "role $DB_USER exists"
  fi
  db_exists="$(sudo -u postgres psql -qAtc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")"
  if [ "$db_exists" != "1" ]; then
    sudo -u postgres psql -qc "CREATE DATABASE $DB_NAME OWNER $DB_USER" >/dev/null
    good "created database $DB_NAME"
  else
    good "database $DB_NAME exists"
  fi
  sudo -u postgres psql -qc "REVOKE ALL ON DATABASE $DB_NAME FROM PUBLIC" >/dev/null 2>&1 || true
else
  note "no local 'postgres' superuser access (Postgres in Docker or remote?). Make sure DATABASE_URL in $ENV_FILE points to a database the app can use."
fi

# ---------------------------------------------------------------------------
step "Application code -> $APP_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude .git "$SRC_DIR/" "$APP_DIR/"
else
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  (cd "$SRC_DIR" && tar --exclude=node_modules --exclude=.git -cf - .) | (cd "$APP_DIR" && tar -xf -)
fi
chown -R root:root "$APP_DIR"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) || die "npm ci failed"
good "code $VERSION installed, dependencies ready"

cat > /usr/local/bin/mchannel-sync <<EOF
#!/usr/bin/env bash
# mchannel-sync command line (see: mchannel-sync help)
cd "$APP_DIR" && exec sudo -u "$APP_USER" env MCHANNEL_SYNC_ENV="$ENV_FILE" node "$APP_DIR/src/cli.js" "\$@"
EOF
chmod 755 /usr/local/bin/mchannel-sync
good "command 'mchannel-sync' installed"

# ---------------------------------------------------------------------------
step "Database tables"
mchannel-sync migrate || die "migration failed - check DATABASE_URL in $ENV_FILE"
good "schema up to date"

# ---------------------------------------------------------------------------
step "PM2 process mchannel-sync"
MCHANNEL_SYNC_USER="$APP_USER" pm2 startOrReload "$APP_DIR/deploy/ecosystem.config.cjs" --update-env >/dev/null
pm2 save >/dev/null
if [ ! -f /etc/systemd/system/pm2-root.service ]; then
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 && pm2 save >/dev/null && good "pm2 start-on-boot enabled" \
    || note "could not enable pm2 start-on-boot (run: pm2 startup)"
else
  good "pm2 start-on-boot already enabled"
fi
healthy=0
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
if [ "$healthy" -eq 1 ]; then
  good "service answers on 127.0.0.1:$PORT  ($(curl -fsS "http://127.0.0.1:$PORT/health"))"
else
  pm2 logs mchannel-sync --lines 30 --nostream || true
  die "service did not start - see the log above"
fi

# ---------------------------------------------------------------------------
if [ -n "$DOMAIN" ] && [ "${SKIP_NGINX:-0}" != "1" ]; then
  step "nginx + SSL for $DOMAIN"
  if ! command -v nginx >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq nginx >/dev/null
  fi
  if [ ! -f "$NGINX_SITE" ]; then
    sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" "$APP_DIR/deploy/nginx-site.conf" > "$NGINX_SITE"
    ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/mchannel-sync.conf
    nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx config test failed"; }
    systemctl reload nginx
    good "nginx site created"
  else
    good "nginx site exists (not changed)"
  fi
  if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    good "certificate for $DOMAIN exists"
  else
    command -v certbot >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx >/dev/null; }
    if [ -n "${CERTBOT_EMAIL:-}" ]; then em=(-m "$CERTBOT_EMAIL"); else em=(--register-unsafely-without-email); fi
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect "${em[@]}" >/tmp/mchannel-certbot.log 2>&1; then
      good "SSL certificate issued"
    else
      note "certbot failed (log: /tmp/mchannel-certbot.log). Add a DNS A record $DOMAIN -> this server's IP, wait a few minutes, then run: certbot --nginx -d $DOMAIN --redirect"
    fi
  fi
  if curl -s -X POST "https://$DOMAIN/mchannel/webhook/check" 2>/dev/null | grep -q 'unknown webhook'; then
    good "https://$DOMAIN/mchannel/webhook/ reaches the service"
  else
    note "https://$DOMAIN/mchannel/webhook/ does not reach the service yet (DNS or SSL still pending?)"
  fi
fi

# ---------------------------------------------------------------------------
step "Done: $ok OK, $warn note(s)"
cat <<EOF
  Settings     $ENV_FILE
  Logs         pm2 logs mchannel-sync
  Status       mchannel-sync list
  Database     sudo -u postgres psql $DB_NAME     (tables in schema mchannel)

  Pair a hotel (code from M-Channel > Connect a PMS, valid 30 minutes):
    mchannel-sync pair --code MCH-XXXX-XXXX --hotel $APP_DIR/docs/hotel.example.json --env staging
EOF
if [ "$NEW_ENV" -eq 1 ]; then
  echo
  echo "  Keep a copy of ENCRYPTION_KEY from $ENV_FILE somewhere safe (password manager)."
fi
