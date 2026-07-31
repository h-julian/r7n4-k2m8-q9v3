import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(PROJECT_DIR, "config.json");
const STATE_PATH = process.env.MONITOR_STATE_PATH
  ? path.resolve(PROJECT_DIR, process.env.MONITOR_STATE_PATH)
  : path.join(PROJECT_DIR, ".alsa-monitor-state.json");
const LOG_PATH = path.join(PROJECT_DIR, "alsa-monitor.log");
const ALSA_HOME = "https://www.alsa.com/en";
const ORIGIN_ID = "2374";
const DESTINATION_ID = "333";

async function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  await fs.appendFile(LOG_PATH, `${line}\n`, "utf8");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function applyEnvironment(config) {
  const environmentRecipients = [
    process.env.ALERT_EMAIL_1,
    process.env.ALERT_EMAIL_2,
  ].filter(Boolean);
  return {
    ...config,
    dates: process.env.MONITOR_DATES
      ? process.env.MONITOR_DATES.split(",").map((value) => value.trim())
      : config.dates,
    browserPath: process.env.CHROME_PATH || config.browserPath,
    resend: {
      ...config.resend,
      apiKey: process.env.RESEND_API_KEY || config.resend?.apiKey,
      from: process.env.RESEND_FROM || config.resend?.from,
      to:
        environmentRecipients.length > 0
          ? environmentRecipients
          : config.resend?.to,
    },
  };
}

function validateConfig(config, { dryRun = false } = {}) {
  if (!Array.isArray(config.dates) || config.dates.length === 0) {
    throw new Error("config.json debe incluir al menos una fecha en dates.");
  }
  if (dryRun) return;

  const required = [
    ["resend.apiKey", config.resend?.apiKey],
    ["resend.from", config.resend?.from],
    ["resend.to", config.resend?.to],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `Faltan valores en config.json: ${missing.join(", ")}. ` +
        "Copia y completa config.example.json.",
    );
  }
  if (!Array.isArray(config.resend.to) || config.resend.to.length !== 2) {
    throw new Error("Configura exactamente dos destinatarios en resend.to.");
  }
  const serializedResend = JSON.stringify(config.resend);
  if (
    /re_CAMBIAR|example\.com/i.test(
      serializedResend,
    )
  ) {
    throw new Error(
      "Completa la clave de Resend y los dos destinatarios antes de activar el monitor.",
    );
  }
}

function findBrowser(config) {
  const candidates = [
    config.browserPath,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].filter(Boolean);

  return candidates;
}

async function resolveBrowserPath(config) {
  for (const candidate of findBrowser(config)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Probar la siguiente ruta.
    }
  }
  throw new Error(
    "No se encontró Chrome o Edge. Indica su ruta en browserPath dentro de config.json.",
  );
}

function toAlsaDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`Fecha no válida: ${isoDate}. Usa AAAA-MM-DD.`);
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function buildSearchUrl(action, isoDate) {
  const url = new URL(action);
  const params = {
    alsaspam: "",
    originStationId: ORIGIN_ID,
    destinationStationId: DESTINATION_ID,
    departureDate: toAlsaDate(isoDate),
    returnDate: "",
    seats: "1",
    promoCode: "",
    youngPromoCode: "",
    travelType: "OUTWARD",
    employee: "false",
    "passengerType-1": "1",
  };
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return url.href;
}

async function getSearchAction(page) {
  await page.goto(ALSA_HOME, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  const html = await page.content();
  const match = html.match(
    /https:\/\/www\.alsa\.com\/en\/checkout\?[^"']*SearchJourneysAction[^"']*/,
  );
  if (!match) {
    throw new Error("ALSA ha cambiado su formulario y no se encontró la búsqueda.");
  }
  return match[0].replaceAll("&amp;", "&");
}

async function extractJourneys(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll("purchase-journey-card")];
    const journeys = cards.map((card) => {
      const times = [...card.querySelectorAll(".journey-card__detail-time")]
        .map((element) => element.textContent.trim())
        .filter(Boolean);
      const warning = card
        .querySelector('[data-testid="warningMsg"]')
        ?.textContent.trim();
      const lines = card.innerText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return {
        departure: times[0] ?? null,
        arrival: times[1] ?? null,
        soldOut:
          card.querySelector(".not-sellable") !== null ||
          /no seats available|no hay plazas disponibles/i.test(warning ?? ""),
        details: [...new Set(lines)].join(" · "),
      };
    });
    return {
      journeys,
      pageText: document.body.innerText.slice(0, 2_000),
    };
  });
}

async function checkDate(page, action, isoDate) {
  const searchUrl = buildSearchUrl(action, isoDate);
  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("purchase-journey-card").length > 0 ||
      /no journeys|no trips|no services|sin servicios/i.test(
        document.body.innerText,
      ),
    null,
    { timeout: 45_000 },
  );

  const result = await extractJourneys(page);
  if (result.journeys.length === 0) {
    throw new Error(
      `ALSA no devolvió tarjetas de viaje para ${isoDate}; se evita asumir disponibilidad.`,
    );
  }
  return {
    date: isoDate,
    searchUrl,
    journeys: result.journeys,
    available: result.journeys.filter((journey) => !journey.soldOut),
  };
}

function fingerprint(journeys) {
  return journeys
    .map((journey) => `${journey.departure}-${journey.arrival}-${journey.details}`)
    .sort()
    .join("|");
}

function fingerprintResults(results) {
  if (results.length === 0) return "NONE";
  return createHash("sha256")
    .update(
      JSON.stringify(
        results.map((result) => ({
          date: result.date,
          available: result.available.map((journey) => ({
            departure: journey.departure,
            arrival: journey.arrival,
            details: journey.details,
          })),
        })),
      ),
    )
    .digest("hex");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function sendWithResend(config, message, idempotencyKey) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: config.resend.from,
      to: config.resend.to,
      ...message,
    }),
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Resend respondió ${response.status}: ${responseBody}`);
  }
  return JSON.parse(responseBody);
}

async function sendAvailabilityEmail(config, results) {
  const textBlocks = [];
  const htmlBlocks = [];
  for (const result of results) {
    textBlocks.push(
      `${result.date}\n${result.available
        .map((journey) => journey.details)
        .join("\n")}\n${result.searchUrl}`,
    );
    const rows = result.available
      .map(
        (journey) =>
          `<li><strong>${escapeHtml(journey.departure ?? "?")} → ` +
          `${escapeHtml(journey.arrival ?? "?")}</strong><br>` +
          `${escapeHtml(journey.details)}</li>`,
      )
      .join("");
    htmlBlocks.push(
      `<h3>${escapeHtml(result.date)}</h3><ul>${rows}</ul>` +
        `<p><a href="${escapeHtml(result.searchUrl)}">Abrir esta búsqueda en ALSA</a></p>`,
    );
  }
  const hash = fingerprintResults(results);
  await sendWithResend(
    config,
    {
      subject: "¡Hay plaza ALSA Jerez–Zamora!",
      text:
        "ALSA muestra plaza disponible para Jerez de la Frontera → Zamora.\n\n" +
        textBlocks.join("\n\n") +
        "\n\nLa disponibilidad puede desaparecer rápidamente.",
      html:
        "<h2>¡Hay plaza en ALSA!</h2>" +
        "<p>Jerez de la Frontera → Zamora</p>" +
        htmlBlocks.join("") +
        "<p><strong>La disponibilidad puede desaparecer rápidamente.</strong></p>",
    },
    `alsa-alert-${hash}`,
  );
}

async function testEmail(config) {
  await sendWithResend(config, {
    subject: "Prueba del monitor ALSA",
    text: "El correo del monitor ALSA está configurado correctamente.",
    html: "<p>El correo del monitor ALSA está configurado correctamente.</p>",
  }, `alsa-test-${Date.now()}`);
  await log(`Correo de prueba enviado a ${config.resend.to.join(", ")}.`);
}

async function writeGitHubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

async function runMonitor(config, { dryRun = false } = {}) {
  const state = await readJson(STATE_PATH, { dates: {} });
  const browserPath = await resolveBrowserPath(config);
  const today = new Date().toISOString().slice(0, 10);
  const activeDates = config.dates.filter((isoDate) => isoDate >= today);
  if (activeDates.length === 0) {
    await log("Todas las fechas vigiladas han pasado; el monitor se desactivará.");
    await writeGitHubOutput("expired", "true");
    return;
  }
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
  });

  try {
    const page = await browser.newPage({ locale: "en-US" });
    const action = await getSearchAction(page);
    const availableResults = [];

    for (const isoDate of activeDates) {
      const result = await checkDate(page, action, isoDate);
      const firstFingerprint = fingerprint(result.available);
      let confirmed = result;

      if (result.available.length > 0) {
        await page.waitForTimeout(1_500);
        confirmed = await checkDate(page, action, isoDate);
      }

      const confirmedFingerprint = fingerprint(confirmed.available);
      const isConfirmed =
        confirmed.available.length > 0 &&
        confirmedFingerprint === firstFingerprint;
      if (isConfirmed) {
        availableResults.push(confirmed);
        await log(
          `Hay ${confirmed.available.length} servicio(s) disponible(s) para ${isoDate}.`,
        );
      } else {
        await log(`Sin plazas para ${isoDate}.`);
      }

      if (!process.env.GITHUB_ACTIONS) {
        state.dates[isoDate] = {
          available: isConfirmed,
          fingerprint: isConfirmed ? confirmedFingerprint : "",
          checkedAt: new Date().toISOString(),
        };
      }
    }

    const currentFingerprint = fingerprintResults(availableResults);
    const previousFingerprint = state.lastAlertFingerprint || "NONE";

    if (
      availableResults.length > 0 &&
      currentFingerprint !== previousFingerprint &&
      dryRun
    ) {
      await log(
        `PRUEBA: la disponibilidad ha cambiado en ${availableResults.length} fecha(s); no se envía correo.`,
      );
    } else if (
      availableResults.length > 0 &&
      currentFingerprint !== previousFingerprint
    ) {
      await sendAvailabilityEmail(config, availableResults);
      await writeGitHubOutput("alert_sent", "true");
      await log(
        `ALERTA enviada a dos destinatarios para ${availableResults.length} fecha(s).`,
      );
    } else if (availableResults.length > 0) {
      await log("La disponibilidad no ha cambiado; no se repite el correo.");
    }

    state.lastAlertFingerprint = currentFingerprint;
    await writeGitHubOutput("alert_fingerprint", currentFingerprint);
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } finally {
    await browser.close();
  }
}

try {
  const fileConfig = await readJson(CONFIG_PATH, {
    dates: ["2026-08-05", "2026-08-06"],
    resend: {},
  });
  const config = applyEnvironment(fileConfig);
  const dryRun = process.argv.includes("--dry-run");
  validateConfig(config, { dryRun });

  if (process.argv.includes("--test-email")) {
    await testEmail(config);
  } else {
    await runMonitor(config, { dryRun });
  }
} catch (error) {
  await log(`ERROR: ${error.stack || error.message}`);
  process.exitCode = 1;
}
