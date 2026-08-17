$ErrorActionPreference = "Stop"
$taskName = "ALSA Zamora-Jerez monitor"

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Tarea eliminada: $taskName"
}
else {
    Write-Host "La tarea no estaba instalada."
}
