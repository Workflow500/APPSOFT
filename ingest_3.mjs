mport { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001"; // guenstig, reicht fuer Extraktion
const OUT = "events.json";
const CACHE = ".ingest-cache.json"; // merkt sich, was sich seit dem letzten Lauf geaendert hat

// ---- Quellen: hier die Termin-/Ticketshop-Seiten eurer Stammfelder eintragen.
//      fieldId muss zur Felderliste in der App passen.
// Getestet am 25.07.2026:
//   ok      = liefert Inhalt beim einfachen Abruf
//   leer    = Inhalt wird per JavaScript nachgeladen, Worker sieht nichts
const SOURCES = [
  // ok - Feldseite mit Preisen, Regeln, Joule, Oeffnungszeiten
  { fieldId: "hotguns-harnekop", name: "Hotguns Harnekop", url: "https://www.hotguns-airsoft.de/" },
  // ok - RSS-Feed desselben Felds, sauberes XML
  { fieldId: "hotguns-harnekop", name: "Hotguns RSS", url: "https://www.hotguns-airsoft.de/rss/news.xml" },
  // ok - ASVZ-Eventseite, reines HTML mit Datum, Ort, Veranstalter
  { fieldId: "hotguns-harnekop", name: "ASVZ Event", url: "https://www.airsoft-verzeichnis.de/index.php?status=event&eventnummer=026535" },
  // ok - Jimdo-Ticketshop von Blackfield: reines HTML, Events mit Datum und Preis
  { fieldId: "blackfield-ueckermuende", name: "Blackfield Ticketshop", url: "https://airsoftuer.jimdofree.com/" },

  // ok - Battleground laeuft auf WordPress mit dem Plugin "The Events Calendar".
  // Die JSON-Schnittstelle liefert Termine direkt strukturiert, ganz ohne Raten.
  { fieldId: "battleground-forst", name: "Battleground (Events API)", url: "https://battleground.de/wp-json/tribe/events/v1/events?per_page=50" },
  // ok - Uebersichts- und Infoseite als Ergaenzung (Preise, Regeln, Infrastruktur)
  { fieldId: "battleground-forst", name: "Battleground Airsoft", url: "https://battleground.de/airsoft/" },

  // leer - Termine liegen im eingebetteten Ticketsystem bookingkit,
  // laedt erst nach Cookie-Zustimmung per JavaScript. Braucht Playwright
  // oder die direkte bookingkit-Adresse.
  // { fieldId: "airsoftoperations", name: "Airsoft Operations", url: "https://airsoftoperations.eu/events/kalender-alle" },

  // leer - blackfield-airsoft.de/events ist eine Wix-Seite, die Terminliste
  // wird per JavaScript nachgeladen. Stattdessen oben den Ticketshop nutzen.

  // gesperrt - area13-leipzig.de untersagt automatisierten Zugriff per robots.txt.
  // Wird bewusst NICHT abgerufen. Termine dort manuell oder ueber ihren
  // externen Ticketshop, falls dessen Adresse bekannt ist.
];

const today = new Date().toISOString().slice(0, 10);

// Funktioniert fuer HTML und fuer RSS/XML gleichermassen:
// Tags raus, CDATA aufloesen, Rest als Fliesstext an die KI.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&euro;/gi, "€")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "AirsoftDE-Teamapp/1.0 (privater Terminabgleich)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  const body = await res.text();
  // JSON-Quellen (z. B. die REST-Schnittstelle des WordPress-Plugins
  // "The Events Calendar" unter /wp-json/tribe/events/v1/events) NICHT
  // durch htmlToText jagen, sonst geht die Struktur kaputt.
  const isJson = type.includes("json") || /^\s*[{[]/.test(body);
  return { body, isJson };
}

async function extractEvents(source, text) {
  const prompt = `Du bekommst den Textinhalt der Webseite eines Airsoft-Spielfelds ("${source.name}").
Extrahiere daraus ALLE angekuendigten Spieltage und Events, die ein konkretes Datum haben.
Heutiges Datum: ${today}. Ignoriere Termine, die klar in der Vergangenheit liegen.

Gib AUSSCHLIESSLICH ein JSON-Array zurueck, ohne weiteren Text und ohne Markdown.
Jedes Objekt hat genau diese Schluessel:
- title (string): Name des Events
- date (string): Startdatum als YYYY-MM-DD
- end (string oder null): Enddatum YYYY-MM-DD bei mehrtaegigen Events, sonst null
- time (string): Uhrzeit wie "09:00 - 17:00" oder "" wenn unbekannt
- duration (string): z.B. "Tagesevent" oder "" wenn unbekannt
- gameType (string): was gespielt wird, oder ""
- joule (string): Joule-Limits, oder ""
- rules (string): kurze Regelhinweise, oder ""
- price (string): Ticketpreise, oder ""
- catering (string): Versorgung vor Ort, oder ""
- desc (string): kurze Zusammenfassung, oder ""

Wichtig: Erfinde nichts. Steht eine Info nicht auf der Seite, nutze "" bzw. null.
Findest du keine Events mit Datum, gib [] zurueck.

Seiteninhalt:
"""${text.slice(0, 12000)}"""`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let out = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  out = out.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [];
  } catch {
    console.warn(`  ! Antwort war kein gueltiges JSON (${source.fieldId})`);
    return [];
  }
}

async function run() {
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY fehlt");
  const all = [];

  // Cache laden. Er merkt sich pro Quelle den Fingerabdruck des Seitentextes
  // und die zuletzt daraus gelesenen Events. Aendert sich die Seite nicht,
  // sparen wir den kompletten KI-Aufruf. Das ist der groesste Kostenhebel:
  // Feldseiten aendern sich selten, geprueft wird aber jeden Tag.
  let cache = {};
  try {
    cache = JSON.parse(await readFile(CACHE, "utf8"));
  } catch {
    console.log("(kein Cache gefunden, erster Lauf)");
  }
  let calls = 0;
  let hits = 0;

  for (const s of SOURCES) {
    try {
      console.log(`> ${s.name}`);
      const { body, isJson } = await fetchPage(s.url);
      const text = isJson ? body : htmlToText(body);
      if (text.length < 200) {
        console.warn("  ! Seite liefert kaum Text - wird vermutlich per JavaScript geladen (Playwright noetig)");
      }

      const hash = createHash("sha256").update(text).digest("hex");
      const prev = cache[s.url];
      let events;
      if (prev && prev.hash === hash) {
        events = prev.events || [];
        hits++;
        console.log(`  unveraendert, ${events.length} Event(s) aus dem Cache (kein KI-Aufruf)`);
      } else {
        events = await extractEvents(s, text);
        calls++;
        cache[s.url] = { hash, events, checked: new Date().toISOString() };
        console.log(`  geaendert, ${events.length} Event(s) neu gelesen`);
      }

      for (const e of events) {
        if (!e.date) continue;
        all.push({
          id: `${s.fieldId}-${e.date}-${slug(e.title)}`,
          fieldId: s.fieldId,
          title: e.title || "Spieltag",
          date: e.date,
          end: e.end || null,
          time: e.time || "",
          duration: e.duration || "",
          gameType: e.gameType || "",
          joule: e.joule || "",
          rules: e.rules || "",
          price: e.price || "",
          catering: e.catering || "",
          desc: e.desc || "",
          sourceUrl: s.url,
        });
      }
    } catch (err) {
      console.warn(`  ! ${s.fieldId}: ${err.message}`);
      // Bei einem Fehler die zuletzt bekannten Events weiterverwenden,
      // damit ein kurzer Ausfall die App nicht leerraeumt.
      const prev = cache[s.url];
      if (prev && prev.events) {
        for (const e of prev.events) {
          if (!e.date) continue;
          all.push({
            id: `${s.fieldId}-${e.date}-${slug(e.title)}`,
            fieldId: s.fieldId,
            title: e.title || "Spieltag",
            date: e.date,
            end: e.end || null,
            time: e.time || "",
            duration: e.duration || "",
            gameType: e.gameType || "",
            joule: e.joule || "",
            rules: e.rules || "",
            price: e.price || "",
            catering: e.catering || "",
            desc: e.desc || "",
            sourceUrl: s.url,
          });
        }
        console.log(`  (nutze ${prev.events.length} Event(s) aus dem Cache weiter)`);
      }
    }
  }

  const seen = new Set();
  const events = all
    .filter((e) => e.date >= today)
    .filter((e) => (seen.has(e.id) ? false : seen.add(e.id)))
    .sort((a, b) => a.date.localeCompare(b.date));

  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), events }, null, 2));
  await writeFile(CACHE, JSON.stringify(cache, null, 2));
  console.log(`\nGeschrieben: ${OUT} (${events.length} Events)`);
  console.log(`KI-Aufrufe: ${calls} · aus Cache: ${hits}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
