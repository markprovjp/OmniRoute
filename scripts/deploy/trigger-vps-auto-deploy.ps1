param(
  [string]$HostName = "84.247.144.97",
  [string]$UserName = "root",
  [string]$IdentityFile = "$HOME/.ssh/omniroute_new_vps_ed25519",
  [switch]$Follow
)

$ErrorActionPreference = "Stop"

$sshArgs = @(
  "-i", $IdentityFile,
  "-o", "IdentitiesOnly=yes",
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=yes",
  "$UserName@$HostName",
  "systemctl start omniroute-deploy.service"
)

& ssh @sshArgs
if ($LASTEXITCODE -ne 0) {
  throw "Failed to start omniroute-deploy.service"
}

if ($Follow) {
  $followArgs = @(
    "-i", $IdentityFile,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "$UserName@$HostName",
    "journalctl -fu omniroute-deploy.service"
  )
  & ssh @followArgs
}
