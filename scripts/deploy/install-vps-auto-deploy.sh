#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CONTROLLER_SOURCE="${SCRIPT_DIR}/omniroute-deploy.mjs"
SERVICE_SOURCE="${SCRIPT_DIR}/systemd/omniroute-deploy.service"
TIMER_SOURCE="${SCRIPT_DIR}/systemd/omniroute-deploy.timer"
CONFIG_PATH="/etc/omniroute-deploy.env"

for command in node git docker flock curl systemctl; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "Required command is missing: ${command}" >&2
    exit 1
  }
done

docker compose version >/dev/null
node --check "${CONTROLLER_SOURCE}"
[[ -f "${SERVICE_SOURCE}" ]] || { echo "Missing ${SERVICE_SOURCE}" >&2; exit 1; }
[[ -f "${TIMER_SOURCE}" ]] || { echo "Missing ${TIMER_SOURCE}" >&2; exit 1; }

REPO_URL=${REPO_URL:-https://github.com/markprovjp/OmniRoute.git}
DEPLOY_REF=${DEPLOY_REF:-main}
LOCAL_HEALTH_URL=${LOCAL_HEALTH_URL:-http://127.0.0.1:20130/}
PUBLIC_HEALTH_URL=${PUBLIC_HEALTH_URL:-https://customer.qrouter.online/}

[[ "${REPO_URL}" =~ ^https://[^[:space:]]+$ ]] || {
  echo "REPO_URL must be a credential-free HTTPS URL." >&2
  exit 1
}
[[ "${REPO_URL}" != *"@"* ]] || {
  echo "REPO_URL must not contain embedded credentials." >&2
  exit 1
}
[[ "${DEPLOY_REF}" =~ ^[A-Za-z0-9._/-]+$ ]] || {
  echo "DEPLOY_REF contains unsupported characters." >&2
  exit 1
}
[[ "${LOCAL_HEALTH_URL}" =~ ^https?://[^[:space:]]+$ ]] || {
  echo "LOCAL_HEALTH_URL must be HTTP(S)." >&2
  exit 1
}
[[ "${PUBLIC_HEALTH_URL}" =~ ^https?://[^[:space:]]+$ ]] || {
  echo "PUBLIC_HEALTH_URL must be HTTP(S)." >&2
  exit 1
}
[[ -f /opt/omniroute/.env ]] || {
  echo "Required production environment file is missing: /opt/omniroute/.env" >&2
  exit 1
}

install -d -m 0755 /usr/local/libexec
install -m 0755 "${CONTROLLER_SOURCE}" /usr/local/libexec/omniroute-deploy.mjs
install -m 0644 "${SERVICE_SOURCE}" /etc/systemd/system/omniroute-deploy.service
install -m 0644 "${TIMER_SOURCE}" /etc/systemd/system/omniroute-deploy.timer
install -d -m 0700 /var/lib/omniroute-deploy
install -d -m 0700 /var/lib/omniroute-deploy/docker-config
install -d -m 0750 /opt/omniroute-releases

if [[ ! -f "${CONFIG_PATH}" || ${FORCE_CONFIG:-0} == 1 ]]; then
  {
    printf 'REPO_URL=%s\n' "${REPO_URL}"
    printf 'DEPLOY_REF=%s\n' "${DEPLOY_REF}"
    printf 'REPO_CACHE=%s\n' '/var/lib/omniroute-deploy/repo.git'
    printf 'RELEASE_ROOT=%s\n' '/opt/omniroute-releases'
    printf 'STATE_DIR=%s\n' '/var/lib/omniroute-deploy'
    printf 'CURRENT_LINK=%s\n' '/opt/omniroute-current'
    printf 'SHARED_ENV=%s\n' '/opt/omniroute/.env'
    printf 'SHARED_TELEGRAM_ENV=%s\n' '/opt/omniroute/.env.telegram'
    printf 'LEGACY_RELEASE_DIR=%s\n' '/opt/omniroute'
    printf 'COMPOSE_PROJECT_NAME=%s\n' 'omniroute'
    printf 'COMPOSE_FILE=%s\n' 'docker-compose.prod.yml'
    printf 'LOCAL_HEALTH_URL=%s\n' "${LOCAL_HEALTH_URL}"
    printf 'PUBLIC_HEALTH_URL=%s\n' "${PUBLIC_HEALTH_URL}"
    printf 'HEALTH_TIMEOUT_SECONDS=%s\n' '120'
    printf 'HEALTH_INTERVAL_MS=%s\n' '2000'
    printf 'BACKUP_RETENTION=%s\n' '5'
  } >"${CONFIG_PATH}"
  chmod 0600 "${CONFIG_PATH}"
  chown root:root "${CONFIG_PATH}"
else
  echo "Keeping existing ${CONFIG_PATH}; set FORCE_CONFIG=1 to replace it."
fi

systemctl daemon-reload
systemctl reset-failed omniroute-deploy.service >/dev/null 2>&1 || true

cat <<'EOF'
OmniRoute deployment controller installed.

One-shot deploy:
  systemctl start omniroute-deploy.service

Follow progress:
  journalctl -fu omniroute-deploy.service

Optional five-minute polling (disabled by default):
  systemctl enable --now omniroute-deploy.timer
EOF
