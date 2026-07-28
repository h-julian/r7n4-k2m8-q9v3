$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $projectDir "alsa-monitor.mjs"
$configPath = Join-Path $projectDir "config.json"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$taskName = "ALSA Jerez-Zamora monitor"

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Falta config.json. Copia y completa config.example.json."
}

$configText = Get-Content -LiteralPath $configPath -Raw
if ($configText -match "re_CAMBIAR|example.com") {
    throw "Completa primero la clave de Resend y los dos destinatarios en config.json."
}

$action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument "`"$scriptPath`"" `
    -WorkingDirectory $projectDir

$trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 10)

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 4)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Comprueba plazas ALSA Jerez-Zamora y avisa por correo." `
    -Force | Out-Null

Write-Host "Tarea instalada: $taskName"
Write-Host "Se ejecutará cada 5 minutos durante 10 días."
