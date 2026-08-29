[English](README.md) · [Русский](README.ru.md) · [中文](README.zh.md) · **Deutsch**

# pi-fleet

Eine Erweiterung für den [Pi coding agent](https://github.com/earendil-works/pi), die Pi eine **selbstheilende Modellflotte** gibt: Sie findet OpenAI-kompatible und Ollama-Endpunkte, überwacht deren Zustand und leitet jede Anfrage an den jeweils besten weiter – mit transparentem Failover. Dazu kommen ein optionales **Mixture of Agents** und ein **lernendes Gedächtnis**.

Alles läuft neben Pis eigenen Providern, die unverändert weiterarbeiten. pi-fleet ist ein Paket, kein Fork.

## Funktionsumfang

- **Dynamische Flotte** – Erkennung im Hintergrund (lokale Seeds, schlüsselloses Censys-Scraping oder die Censys-API), Lebendigkeits- sowie Latenz-/Durchsatzmessungen, Circuit Breaker pro Endpunkt und Routing, gewichtet nach Modellstärke, Latenz, Durchsatz, Gesundheit, Zuverlässigkeit und Kontextfenster.
- **Transparentes Failover** – trifft eine Anfrage einen langsamen oder defekten Endpunkt, wird sie auf dem nächstbesten wiederholt; der Breaker öffnet nach wiederholten Fehlern und erholt sich von selbst.
- **Mixture of Agents (MoA)** – optional. Führt mehrere Modelle parallel aus; ein Aggregator fasst eine Antwort zusammen. Funktioniert über lokale und externe Provider hinweg und degradiert bei Worker-Ausfällen kontrolliert.
- **Gedächtnis** – lernt aus Tool-Ergebnissen Fallstricke und Umgehungen und spielt die passenden vor einem Zug ein. Ein begrenztes, umkehrbares **Self-Evolution** stimmt die Flottenkonfiguration an einer messbaren Metrik ab. Als Backend dient [Hindsight](https://github.com/vectorize-io/hindsight), sofern verfügbar, sonst ein lokaler SQLite-Speicher ohne Abhängigkeiten.

## Installation

```bash
pi install git:github.com/<you>/pi-fleet      # oder: pi install npm:pi-fleet
# oder die Erweiterung direkt laden:
pi -e /path/to/pi-fleet/src/ext/fleet-extension.ts
```

Benötigt Node ≥ 22 (nutzt das eingebaute `node:sqlite`). Pi findet die Erweiterung über den `pi`-Schlüssel in `package.json`.

## Konfiguration

Legen Sie eine `fleet.config.json` ins Arbeitsverzeichnis, nach `~/.pi/agent/`, oder verweisen Sie mit `PI_FLEET_CONFIG` darauf. Alle Felder sind optional; die Standardwerte stehen in [`examples/fleet.config.json`](examples/fleet.config.json). Am ehesten anpassen werden Sie:

```jsonc
{
  "gatewayPort": 47600,             // lokaler Port, mit dem Pi spricht (siehe „Funktionsweise“)
  "discovery": {
    "seeds": ["127.0.0.1:11434"],   // lokales Ollama und beliebige eigene host:port
    "censys": {
      "enabled": true,
      "query": "host.services.software.product = \"ollama\" or web.software.product = \"ollama\"",
      "browser": { "enabled": true } // schlüsselloses Live-Scraping (Standard) – siehe unten
    }
  },
  "routing": { "capability": 1.0, "latency": 0.8, "throughput": 0.5, "health": 1.2, "reliability": 1.0, "context": 0.3 },
  "moa": { "enabled": false, "workers": 3, "policy": "diverse", "aggregatorModel": "", "minWorkers": 1 },
  "memory": { "enabled": true, "backend": "hindsight", "fallbackToNative": true },
  "evolution": { "enabled": false, "autoApply": false },
  "providers": [                    // externe / lokale OpenAI-kompatible Endpunkte im Pool
    { "id": "openrouter", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "$OPENROUTER_API_KEY",
      "models": [{ "id": "meta-llama/llama-3.1-70b-instruct", "sizeB": 70, "contextWindow": 131072 }] }
  ]
}
```

### Erkennung (standardmäßig schlüssellos)

Die Censys-Weboberfläche liegt hinter Cloudflare und einer Anmeldeschranke, daher liefert eine einfache HTTP-Anfrage nur eine Challenge-Seite. pi-fleet rendert die Ergebnisse deshalb über den [browser-search](https://github.com/Johell1NS/browser-search)-Stack (Camofox / camoufox, ein Stealth-Browser) und liest host:port aus dem gerenderten HTML – **ohne Censys-API-Schlüssel**.

**Einrichtung** – den browser-search-Stack installieren und dessen Camofox-Container starten:

```bash
npm run setup:browser-search   # browser-search klonen + installieren, Camofox auf 127.0.0.1:9377 starten
```

Das läuft auch automatisch bei `npm install` (nur Code – klont und installiert browser-search, startet aber nicht den Container; übersprungen in CI oder mit `PI_FLEET_SKIP_SETUP=1`). Benötigt `git` sowie `podman` oder `docker` für den Container. Am Ende wird die zu exportierende Zugangsangabe ausgegeben:

```bash
export CAMOFOX_API_KEY=<generierter Schlüssel>   # muss mit dem laufenden Camofox-Container übereinstimmen
```

Das ist die einzige Zugangsangabe, die der schlüssellose Weg braucht. `BROWSER_SEARCH_DIR` wird für Sie geschrieben, und `PI_FLEET_DIR` (zum Auffinden des Standard-Scrape-Befehls) setzen die Erweiterung und das CLI selbst.

Jeder Fetcher, der das gerenderte HTML ausgibt, funktioniert – verweisen Sie `discovery.censys.browser.command` darauf. Zum Beispiel Firecrawl:

```jsonc
"command": ["firecrawl", "scrape", "{url}", "--format", "html", "--wait-for", "9000"],
"resultPath": ""
```

Die Quellen lassen sich kombinieren: `discovery.seeds`, gespeicherte Censys-Seiten über `discovery.censys.htmlImports` und die Censys-API, wenn `CENSYS_API_ID` / `CENSYS_API_SECRET` gesetzt sind. Gefundene Hosts werden geprüft (`/api/tags` → eine echte Chat-Completion); nur verifizierte Endpunkte kommen in die Flotte. Ein schlüsselloser Live-Lauf über diesen Weg fand 70+ erreichbare Endpunkte.

> Richten Sie die Erkennung nur auf Endpunkte, die Sie nutzen dürfen.

### Gedächtnis-Backend

`memory.backend` ist standardmäßig `"hindsight"`. Beim Start prüft pi-fleet den Hindsight-Dienst (`memory.hindsight.baseUrl`); antwortet er, werden Lektionen dort abgelegt und abgerufen. Andernfalls übernimmt bei aktivem `fallbackToNative` (Standard) der lokale SQLite-Speicher – das Gedächtnis funktioniert also ohne externen Dienst. Der native Speicher läuft in jedem Fall, weil die Self-Evolution auf ihm aufsetzt.

Betreiben Sie Hindsight selbst (Docker/Postgres) gemäß dessen Doku und setzen Sie dann `memory.hindsight.baseUrl` sowie bei Bedarf `HINDSIGHT_API_KEY`.

## Verwendung in Pi

Wählen Sie die Flotte als Modell:

```bash
pi --provider fleet --model auto                          # gewichtetes Routing + Failover
pi --provider fleet --model moa                           # Mixture of Agents (wenn moa.enabled)
pi --provider fleet --model "127.0.0.1:11434/llama3.1:70b" # ein bestimmtes gefundenes Modell festpinnen
```

Befehle:

| Befehl | Wirkung |
|---|---|
| `/fleet` | Endpunkte, Gesundheit, Breaker-Zustand, Modelle, Gedächtnis-Backend |
| `/fleet-refresh` | Sofort eine Erkennung + Gesundheitsprüfung erzwingen |
| `/fleet-moa on\|off` | Mixture of Agents ein-/ausschalten |
| `/fleet-evolve` | Jetzt einen begrenzten Self-Evolution-Zyklus ausführen |
| `/fleet-remember <Text>` | Eine Umgebungstatsache / Lektion speichern |

## Eigenständiges CLI

Die Flotte ohne Start von Pi bedienen:

```bash
npm run fleetctl -- discover        # ein Erkennungs- + Gesundheitsdurchlauf, Status ausgeben
npm run fleetctl -- status
npm run fleetctl -- import page.html   # host:port aus einer gespeicherten Censys-Seite extrahieren
npm run fleetctl -- chat "hallo"    # eine Anfrage durch die Flotte leiten
npm run fleetctl -- memory          # gespeicherte Lektionen auflisten
```

## Funktionsweise

Pi spricht mit einem kleinen lokalen **Gateway** (`gatewayPort`) wie mit einem gewöhnlichen OpenAI-kompatiblen Provider. Das Gateway leitet jede Anfrage durch die Engine, sodass Pis Modellverarbeitung auf ihrem unterstützten Pfad bleibt:

```
Erkennung (Seeds / Browser-Scrape / Censys-API) → Probe → Registry (EWMA-Statistik + Circuit Breaker)
                                                            │
        Anfrage ──► Router (gewichtete Bewertung) ──► Failover-Executor ──► Endpunkt
                                                    └► MoA: parallele Worker → Aggregator
Beobachtungen ──► Gedächtnis (Hindsight oder natives SQLite) ──► Self-Improvement / Self-Evolution
```

- **Circuit Breaker** – `failureThreshold` aufeinanderfolgende Fehler öffnen einen Endpunkt; nach `cooldownMs` geht er für einen Versuch auf Half-Open; `recoveryThreshold` Erfolge schließen ihn wieder.
- **Self-Evolution** – begrenzt und umkehrbar. Automatisch angewendet werden nur *Konfigurations*änderungen (einen wackligen Endpunkt in Quarantäne stellen, Routing-Gewichte nachjustieren), die eine Metrik messbar verbessern; sonst Rollback. Alles, was Code oder Skills berührt, wird als git-verfolgter, rein zur Prüfung gedachter Vorschlag unter `.pi/fleet-evolution/` abgelegt.

Transienter Zustand liegt unter `~/.pi/agent/fleet/` (native Gedächtnisdatenbank, Evolutions-Artefakte). Nichts Sensibles wird committet.

## Tests

```bash
npm test          # Unit + Integration + End-to-End (prozessinterne Mock-Endpunkte; keine externen Hosts)
npm run typecheck
```

Die End-to-End-Suite (`test/e2e.test.ts`) deckt ab: Erkennung und Refresh, Gesundheitsübergänge, Routing, transparentes Failover, Endpunkt-Erholung, Zusammenspiel lokaler und externer Provider, MoA-Erfolg und teilweisen Worker-Ausfall, Persistenz und Abruf von Lektionen, die geplanten Schleifen, Annahme und Rollback der Self-Evolution sowie einen sauberen Neustart mit persistiertem Zustand.

## Danksagung

Baut auf der Arbeit von:

- **[browser-search](https://github.com/Johell1NS/browser-search)** von [@Johell1NS](https://github.com/Johell1NS) – der Camofox- (camoufox) / CloakBrowser-Stack, der die schlüssellose Censys-Erkennung antreibt.
- **[Pi coding agent](https://github.com/earendil-works/pi)** von [earendil-works](https://github.com/earendil-works) – der Host-Agent, den dieses Paket erweitert.
- **[Hindsight](https://github.com/vectorize-io/hindsight)** von [vectorize-io](https://github.com/vectorize-io) – das Standard-Gedächtnis-Backend.
- **[Firecrawl](https://github.com/firecrawl/firecrawl)** – ein alternativer Fetcher für gerendertes HTML bei der Erkennung.

Die Erkennungs-Pipeline begann als zwei Python-Skripte (`extract_ollama_hosts.py`, `ollama_recon.py`) und wurde hier nach TypeScript portiert.

## Lizenz

MIT – siehe [LICENSE](LICENSE).
