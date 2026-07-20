---
title: "Host-side Docker Auto-deploy"
version: 3.8.1
lastUpdated: 2026-07-20
---

# Host-side Docker Auto-deploy

OmniRoute can deploy a selected public Git ref from a systemd service on the Docker host. The
controller runs outside the application containers, so an OmniRoute restart or an interrupted agent
connection does not terminate an in-progress deployment.

## Safety model

The controller:

1. Fetches and resolves one exact commit.
2. Exports an immutable release directory under `/opt/omniroute-releases/`.
3. Builds commit-addressed app and Telegram images while production remains online.
4. Creates an online SQLite backup through `better-sqlite3` before the container swap.
5. Stops only the watchdog, then recreates the app container. Redis and Caddy remain online.
6. Requires Docker health, the local Caddy upstream, and the public HTTPS endpoint to pass.
7. Recreates the Telegram bot and watchdog after app health succeeds.
8. Automatically recreates the previous release/images when candidate health fails.

Application rollback does not automatically restore SQLite because restoring a pre-deploy database can
discard writes. The backup path is retained in `/var/lib/omniroute-deploy/current.json` and the systemd
journal for manual disaster recovery.

The persistent `omniroute-prod-data` volume is reused. API keys, provider credentials, quota state,
compression settings, analytics, credit history, and image-generation audit data therefore survive a
deployment.

## Install

Run from a trusted checkout on the VPS as root:

```bash
DEPLOY_REF=main scripts/deploy/install-vps-auto-deploy.sh
```

The installer writes:

- `/usr/local/libexec/omniroute-deploy.mjs`
- `/etc/omniroute-deploy.env`
- `/etc/systemd/system/omniroute-deploy.service`
- `/etc/systemd/system/omniroute-deploy.timer`

The timer is installed but remains disabled.

## One-shot deployment

```bash
systemctl start omniroute-deploy.service
systemctl status omniroute-deploy.service --no-pager
journalctl -u omniroute-deploy.service -n 200 --no-pager
```

Starting the unit again is safe. The controller uses a host lock and skips a commit that is already
recorded and healthy.

From Windows, the repository helper can trigger the same service over key-only SSH:

```powershell
./scripts/deploy/trigger-vps-auto-deploy.ps1 -Follow
```

## Optional polling

Enable five-minute Git polling only after validating one-shot deployment and rollback:

```bash
systemctl enable --now omniroute-deploy.timer
systemctl list-timers omniroute-deploy.timer
```

Disable polling without stopping production:

```bash
systemctl disable --now omniroute-deploy.timer
```

This is host polling, not GitHub Actions. Fetching a public repository does not require GitHub account
credentials.

## Configuration

`/etc/omniroute-deploy.env` is root-owned with mode `0600`. Important values:

| Variable                 | Purpose                                               |
| ------------------------ | ----------------------------------------------------- |
| `REPO_URL`               | Credential-free public HTTPS repository URL.          |
| `DEPLOY_REF`             | Branch, tag, or ref fetched for deployment.           |
| `SHARED_ENV`             | Existing production `.env`; never copied into Git.    |
| `LOCAL_HEALTH_URL`       | Local Caddy upstream check.                           |
| `PUBLIC_HEALTH_URL`      | Public HTTPS verification.                            |
| `HEALTH_TIMEOUT_SECONDS` | Candidate health deadline.                            |
| `BACKUP_RETENTION`       | Number of controller-created SQLite backups retained. |

Do not embed usernames, passwords, tokens, or deploy keys in `REPO_URL`.

## Observability

```bash
journalctl -fu omniroute-deploy.service
docker ps --filter name=omniroute
docker inspect -f '{{.Config.Image}} {{.State.Health.Status}}' omniroute-prod
readlink -f /opt/omniroute-current
```

Deployment state is written atomically to `/var/lib/omniroute-deploy/current.json`.

## Manual application rollback

Normally candidate failure triggers application rollback automatically. To redeploy the last recorded
healthy SHA, leave `DEPLOY_REF` unchanged and remove or correct only the failing upstream ref, then start
the service again. For database restoration, stop the app and bot first and follow the SQLite recovery
procedure using the exact `backupPath` recorded in deployment state. Never overwrite a live WAL database
with a plain file copy.
