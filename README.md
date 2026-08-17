# Monitor de plazas ALSA con GitHub Actions y Resend

Comprueba cada cinco minutos los viajes de **Zamora a Jerez de la Frontera**
seleccionados para la vuelta:

- todos los servicios del domingo 30 de agosto de 2026;
- todos los servicios del lunes 31 de agosto de 2026;
- solo el servicio de las 02:15 del martes 1 de septiembre de 2026.

Si aparece una plaza:

1. vuelve a comprobarla para evitar falsos positivos;
2. envía una única alerta mediante Resend a dos destinatarios;
3. guarda la disponibilidad avisada para no repetir el mismo correo.

El workflow sigue activo para detectar horarios nuevos o plazas que reaparezcan,
y solo se desactiva cuando las fechas ya han pasado. No compra ni reserva.
Funciona en GitHub Actions aunque el ordenador personal esté apagado.

## Configuración en GitHub

El repositorio utiliza estos valores:

| Tipo | Nombre | Valor |
| --- | --- | --- |
| Secret | `RESEND_API_KEY` | Clave real `re_...` de Resend |
| Secret | `ALERT_EMAIL_1` | Primer destinatario |
| Secret | `ALERT_EMAIL_2` | Segundo destinatario |
| Variable | `RESEND_FROM` | `Monitor ALSA <alertas@mycv.es>` |
| Variable | `MONITOR_ENABLED` | `false` durante la preparación; `true` para activar |

La memoria del último aviso se guarda en `.github/alsa-monitor-state.json`.
Solo contiene una huella técnica y se actualiza cuando cambia la disponibilidad.

Antes de activar, `mycv.es` debe aparecer como dominio verificado en Resend y
la dirección indicada en `RESEND_FROM` debe pertenecer a ese dominio.

La clave de Resend nunca debe guardarse en un archivo ni enviarse por chat.
Se introduce desde **Settings → Secrets and variables → Actions → Secrets**.

## Activación

1. Sustituye el secreto `RESEND_API_KEY`.
2. Sustituye `ALERT_EMAIL_1` y `ALERT_EMAIL_2`.
3. Comprueba `RESEND_FROM`.
4. Cambia `MONITOR_ENABLED` a `true`.
5. En **Actions**, abre “Monitor ALSA Zamora-Jerez” y ejecuta
   **Run workflow** una vez para verificarlo inmediatamente.

Después se ejecutará automáticamente cada cinco minutos.

## Prueba local opcional

Copia `config.example.json` como `config.json`, añade la clave y los dos
destinatarios y ejecuta:

```powershell
npm.cmd install
npm.cmd run test-email
npm.cmd run check
```

Para probar solo la consulta de ALSA sin enviar correo:

```powershell
npm.cmd run dry-run
```

Los datos sensibles de `config.json`, el estado y los registros locales están
excluidos de Git.
