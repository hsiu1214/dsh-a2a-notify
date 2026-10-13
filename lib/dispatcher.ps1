# dsh-a2a-notify dispatcher.
# Runs on the INTERACTIVE desktop via the per-user scheduled task
# "a2a-notify-dispatch". The DSH Host (and every child it spawns) lives in a
# sandbox whose UI never reaches the user's desktop - verified: balloons from
# the Host chain are silently dropped, while the same balloon fired through a
# scheduled task renders fine. So the plugin drops request files into
# ~/.dsh/a2a-notify/pending/ and runs this task; this script claims each file
# (atomic rename), shows one balloon, then deletes it.
#
# Concurrency: several dispatchers may run at once (rapid notifications).
# The rename-claim below makes each request file owned by exactly one runner.
# Never interactive; exit 0 on success, non-zero on failure (ignored by caller).
$ErrorActionPreference = 'Stop'
try {
    if ($env:OS -ne 'Windows_NT') { exit 0 }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $pendingDir = Join-Path $env:USERPROFILE '.dsh\a2a-notify\pending'
    if (-not (Test-Path $pendingDir)) { exit 0 }

    Get-ChildItem -Path $pendingDir -Filter 'pending-*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
        $claim = $_.FullName + '.claim'
        try {
            # Atomic claim: only one dispatcher wins the rename.
            Rename-Item -Path $_.FullName -NewName ($_.Name + '.claim') -ErrorAction Stop
        } catch {
            return  # another dispatcher already claimed it
        }
        try {
            $req = Get-Content -Path $claim -Raw -Encoding UTF8 | ConvertFrom-Json
            $icon = New-Object System.Windows.Forms.NotifyIcon
            $icon.Icon = [System.Drawing.SystemIcons]::Information
            $icon.Visible = $true
            $icon.BalloonTipTitle = [string]$req.title
            $icon.BalloonTipText = [string]$req.message
            $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
            $icon.ShowBalloonTip(8000)
            Start-Sleep -Seconds 3   # let consecutive balloons queue visually
            $icon.Visible = $false
            $icon.Dispose()
        } catch { /* a malformed request must not wedge the dispatcher */ }
        Remove-Item -Path $claim -Force -ErrorAction SilentlyContinue
    }
    exit 0
} catch {
    exit 1
}
