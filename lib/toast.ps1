# dsh-a2a-notify toast helper (balloon-tip implementation).
# Fired detached by lib/index.js: powershell.exe -NoProfile -File toast.ps1 -Title .. -Message ..
#
# Why balloon and not WinRT ToastNotification: a detached powershell.exe child
# of the DSH Host has no MSIX package identity, and CreateToastNotifier rejects
# it with 0x80073D54 even after SetCurrentProcessExplicitAppUserModelID.
# NotifyIcon.ShowBalloonTip needs no identity, ships with .NET in Windows
# PowerShell 5.1, and renders as a standard corner notification on Win10/11.
# Never interactive; exit 0 on success, non-zero on failure (ignored by caller).
param(
    [string]$Title = '',
    [string]$Message = ''
)
$ErrorActionPreference = 'Stop'
try {
    if ($env:OS -ne 'Windows_NT') { exit 0 }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Information
    $icon.Visible = $true
    $icon.BalloonTipTitle = $Title
    $icon.BalloonTipText = $Message
    $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $icon.ShowBalloonTip(8000)

    # NotifyIcon dies with the process: stay alive long enough for the balloon
    # to be picked up by the notification area, then clean up.
    Start-Sleep -Seconds 10
    $icon.Visible = $false
    $icon.Dispose()
    exit 0
} catch {
    exit 1
}
