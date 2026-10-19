<#
.SYNOPSIS
  Seeds or rotates the SSM parameters the Enshrouded server needs (RUNBOOK 1.3).

.DESCRIPTION
  Two modes.

  SEED (default) writes everything: server name, slot count, the four user-group
  passwords, and the Discord bot token. The token is read from the clipboard
  because Read-Host -AsSecureString uses a raw key reader that swallows Ctrl+V in
  the Windows console, making a ~70-character token impossible to paste.

  ROTATE (-RotatePassword) regenerates one or more group passwords and touches
  nothing else. No token needed.

  Every write uses --overwrite, so both modes are safe to re-run.

.PARAMETER ServerName
  Name shown in the in-game server browser. Seed mode only.

.PARAMETER SlotCount
  Player slots, 1-16 (16 is the hard game cap). Seed mode only.

.PARAMETER Token
  Discord bot token. Omit it and the clipboard is read instead, which is the
  normal path. Seed mode only.

.PARAMETER KeepPasswords
  Seed mode: leave the existing group passwords alone and write only the name,
  slot count and token.

.PARAMETER RotatePassword
  Rotate mode: which group passwords to regenerate. One or more of admin,
  friend, guest, visitor, or 'all'. Nothing else is written.

.PARAMETER DryRun
  Print what would be written without calling AWS.

.EXAMPLE
  .\scripts\seed-parameters.ps1
  First-time setup. Copy the bot token first, then press Enter when prompted.

.EXAMPLE
  .\scripts\seed-parameters.ps1 -RotatePassword guest
  Someone leaked the guest password. Rotates only that one.

.EXAMPLE
  .\scripts\seed-parameters.ps1 -RotatePassword admin,friend

.EXAMPLE
  .\scripts\seed-parameters.ps1 -RotatePassword all

.EXAMPLE
  .\scripts\seed-parameters.ps1 -KeepPasswords
  Rotate only the Discord bot token, leaving group passwords intact.
#>
[CmdletBinding(DefaultParameterSetName = 'Seed')]
param(
  [Parameter(ParameterSetName = 'Seed')]
  [string]$ServerName = "Dave's Enshrouded Server",

  [Parameter(ParameterSetName = 'Seed')]
  [ValidateRange(1, 16)][int]$SlotCount = 16,

  [Parameter(ParameterSetName = 'Seed')]
  [string]$Token,

  [Parameter(ParameterSetName = 'Seed')]
  [switch]$KeepPasswords,

  [Parameter(ParameterSetName = 'Rotate', Mandatory = $true)]
  [ValidateSet('admin', 'friend', 'guest', 'visitor', 'all')]
  [string[]]$RotatePassword,

  [switch]$DryRun,
  [string]$Region = 'us-east-2'
)

$ErrorActionPreference = 'Stop'
$prefix = '/enshroudedproj'
$allGroups = @('admin', 'friend', 'guest', 'visitor')
$rotating = $PSCmdlet.ParameterSetName -eq 'Rotate'

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  $msg" -ForegroundColor Green }
function Write-Note($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }

# Which groups get a new password this run.
if ($rotating) {
  $targets = if ($RotatePassword -contains 'all') { $allGroups }
  else { $allGroups | Where-Object { $_ -in $RotatePassword } }
}
elseif ($KeepPasswords) { $targets = @() }
else { $targets = $allGroups }

Write-Host ("Mode: {0}" -f $(if ($rotating) { "ROTATE ($($targets -join ', '))" } else { 'SEED' })) -ForegroundColor Magenta

# --- preflight -------------------------------------------------------------
Write-Step 'Checking prerequisites'

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw 'The AWS CLI is not on PATH. Install it, or open a new terminal if you just did.'
}
Write-Ok 'aws CLI found'

if (-not $DryRun) {
  $ident = aws sts get-caller-identity --output json 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "AWS credentials are not working. ``aws sts get-caller-identity`` said:`n$ident"
  }
  $acct = ($ident | ConvertFrom-Json).Account
  if ($acct -ne '334953720182') {
    throw "Wrong AWS account: expected 334953720182, got $acct. Check your profile."
  }
  Write-Ok "authenticated to account $acct in $Region"
}
else {
  Write-Note 'dry run - no AWS calls will be made'
}

# --- the Discord bot token (seed mode only) --------------------------------
# Taken before anything is written, so an empty clipboard cannot leave Parameter
# Store half-populated.
if (-not $rotating) {
  Write-Step 'Discord bot token'

  if (-not $Token) {
    Write-Host '  Copy the token from the Developer Portal:' -ForegroundColor Yellow
    Write-Host '    your app > Bot > Reset Token > Copy' -ForegroundColor Yellow
    Write-Host '  Then press Enter here: ' -NoNewline
    [void](Read-Host)

    $Token = Get-Clipboard -Raw
    if ([string]::IsNullOrWhiteSpace($Token)) {
      throw 'The clipboard was empty. Copy the token, then run this again.'
    }
  }
  $Token = $Token.Trim()

  # Shape check without ever printing the value. A bot token is three
  # dot-separated base64url segments; catching a mis-copy here beats debugging
  # 401s from the interactions endpoint later.
  if ($Token -notmatch '^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$') {
    Write-Host ''
    Write-Warning ("That does not look like a Discord bot token " +
      "($($Token.Length) chars, expected 3 dot-separated segments).")
    Write-Warning 'A common mistake is copying the application PUBLIC KEY or CLIENT SECRET instead.'
    $ans = Read-Host '  Continue anyway? (y/N)'
    if ($ans -ne 'y') { throw 'Aborted - nothing was written.' }
  }
  Write-Ok "token accepted ($($Token.Length) chars, starts '$($Token.Substring(0,[Math]::Min(4,$Token.Length)))...')"
}

# --- generate --------------------------------------------------------------
function New-GamePassword {
  -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object { [char]$_ })
}

$pw = [ordered]@{}
foreach ($g in $targets) { $pw[$g] = New-GamePassword }

# --- write -----------------------------------------------------------------
function Set-Param($Name, $Value, $Type) {
  $full = "$prefix/$Name"
  if ($DryRun) {
    $shown = if ($Type -eq 'SecureString') { '<hidden>' } else { $Value }
    Write-Note "would write $full [$Type] = $shown"
    return
  }
  $out = aws ssm put-parameter --region $Region --name $full `
    --type $Type --value $Value --overwrite 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Failed writing ${full}:`n$out" }
  Write-Ok "wrote $full [$Type]"
}

Write-Step 'Writing parameters'

if (-not $rotating) {
  Set-Param 'server/name'       $ServerName  'String'
  Set-Param 'server/slot-count' "$SlotCount" 'String'
}

foreach ($g in $targets) { Set-Param "server/user-groups/$g-password" $pw[$g] 'SecureString' }
if (-not $targets) { Write-Note 'no group passwords changed' }

if (-not $rotating) { Set-Param 'discord/bot-token' $Token 'SecureString' }

# --- tidy up ---------------------------------------------------------------
if (-not $rotating -and -not $PSBoundParameters.ContainsKey('Token')) {
  try { Set-Clipboard -Value ' ' } catch { }
  Write-Note 'clipboard cleared'
}
Remove-Variable Token -ErrorAction SilentlyContinue

# --- report ----------------------------------------------------------------
if ($targets) {
  Write-Host "`nNew passwords - SAVE THESE NOW, they are not recoverable in plaintext:" -ForegroundColor Yellow
  $pw.GetEnumerator() |
    Format-Table @{L = 'Group'; E = { $_.Key } }, @{L = 'Password'; E = { $_.Value } } -AutoSize |
    Out-String | Write-Host
  Write-Host '  Admin can kick/ban and edit the world; Visitor can do neither.' -ForegroundColor DarkGray
  if ($rotating) {
    Write-Host '  Players using the old password(s) are locked out until you share these.' -ForegroundColor DarkGray
  }
}

if (-not $DryRun) {
  Write-Step 'Stored parameters (names and types only - values are never printed)'
  # Filter CLIENT-SIDE rather than with --parameter-filters. Both server-side forms
  # are broken from PowerShell: the CLI shorthand
  # ("Key=Name,Option=BeginsWith,Values=...") silently returns ZERO matches even when
  # the parameters exist, and the JSON form loses its double quotes to PowerShell's
  # native-argument quoting, so the CLI receives invalid JSON. Both verified against a
  # populated store. A silently-empty result would make this check report success-by-
  # absence, so it is filtered here instead. Do not "simplify" this back.
  $all = (aws ssm describe-parameters --region $Region `
      --query 'Parameters[].[Name,Type]' --output text) -split "`n" |
    Where-Object { $_ -match "^$prefix/" }

  Write-Host ''
  $all | ForEach-Object { Write-Host ("  {0}" -f ($_ -replace '\s+', '  ')) }

  $expected = @(
    "$prefix/server/name", "$prefix/server/slot-count", "$prefix/discord/bot-token"
  ) + ($allGroups | ForEach-Object { "$prefix/server/user-groups/$_-password" })

  $actual = (aws ssm describe-parameters --region $Region `
      --query 'Parameters[].Name' --output text) -split '\s+' |
    Where-Object { $_ -like "$prefix/*" }

  $missing = $expected | Where-Object { $_ -notin $actual }
  if ($missing) {
    Write-Host ''
    Write-Warning "Not yet present: $($missing -join ', ')"
    if (-not $rotating) { exit 1 }
    Write-Note 'expected if you have not run a full seed yet'
  }
  else {
    Write-Host ''
    Write-Ok 'all required parameters present'
  }
}

if ($rotating) {
  Write-Host "`nDone. Redeploy the game server so the new password(s) take effect:" -ForegroundColor Green
  Write-Host '  gh workflow run deploy-game-server.yml' -ForegroundColor Green
}
else {
  Write-Host "`nDone. Next: merge PR #1 to trigger the first deploy." -ForegroundColor Green
}
