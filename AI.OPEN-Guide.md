# AI.OPEN — Der Guide für datenschutzkonforme State-of-the-Art KI bei OPEN

**Stand:** 12.06.2026
**Plattform:** [https://ai.open.de](https://ai.open.de)

---

## Inhalt

1. [Was ist AI.OPEN?](#was-ist-aiopen)
2. [Verfügbare Modelle](#verfügbare-modelle)
3. [Architektur, Datenschutz & Kostenzuordnung](#architektur-datenschutz--kostenzuordnung)
4. [Für End User](#für-end-user--ai-studio-im-browser-oder-claude-desktop-app) — AI Studio im Browser oder Claude Desktop App
5. [Prompts & Skills Library](#prompts--skills-library--zentrale-wiederverwendung) — zentrale Wiederverwendung
6. [Für Developer](#für-developer--sprachmodelle-in-coding-tools) — Sprachmodelle in Coding-Tools
7. [Für Admins & Team-Leads](#für-admins--team-leads--budgets-user--controlling) — Budgets, User & Controlling
8. [Roadmap & Vision](#roadmap--vision)
9. [Ansprechpartner — Wer macht was?](#ansprechpartner--wer-macht-was)

---

## Was ist AI.OPEN?

AI.OPEN ist die zentrale, **datenschutzkonforme KI-Plattform von OPEN**. Sie stellt allen Mitarbeitenden Zugriff auf die aktuellsten State-of-the-Art Sprachmodelle bereit — über ein einheitliches Gateway, das automatisch:

- Anfragen über **datenschutzkonforme Umgebungen** (GCP, Vertex AI, Anthropic-EU) routet,
- die Nutzung den korrekten **Teams, Rollen, Benutzern und Projekten** zuordnet,
- **Kosten transparent und controllinggerecht** erfasst.

Damit ist AI.OPEN sowohl für klassische End-User (Chat, Agents) als auch für Developer (IDE-Integrationen, Coding-Agents) und für Admins (Budget- & User-Management) der zentrale Einstiegspunkt für jegliche KI-Nutzung bei OPEN.

> **ℹ️ Abgrenzung — was AI.OPEN nicht ist**
>
> AI.OPEN ersetzt **nicht** die bei OPEN etablierte **Gemini-Nutzung** im Google Workspace (Gmail, Docs, Meet etc.) — das bleibt eine separate, eigenständige Schiene. AI.OPEN adressiert gezielt die Nutzung von Sprachmodellen über das zentrale Gateway, für eigene Agents, Coding-Workflows und projektbezogene KI-Anwendungen.

> **💬 Austausch zu AI.OPEN**
>
> Alle wichtigen Diskussionen, Ankündigungen, Tipps und Fragen rund um AI.OPEN finden im
> **Google Chat Kanal** statt: [https://chat.google.com/u/0/app/chat/AAAAKWkq6-k](https://chat.google.com/u/0/app/chat/AAAAKWkq6-k)
>
> → Bitte tritt dem Kanal bei, um nichts zu verpassen.

---

## Verfügbare Modelle

Eine schreibgeschützte Übersicht aller verfügbaren Modelle (Stand 12.06.2026) findet sich unter [https://ai.open.de/models](https://ai.open.de/models):

| Modell | Kontext (in / out) | Modalitäten | Kosten (in / out per 1M Tokens) |
|---|---|---|---|
| vertex-gemini-3.5-flash | 1.0M / 66K | vision, pdf, audio, tools | $1.50 / $9.00 |
| gemini-3.1-flash-lite | 1.0M / 66K | vision, pdf, audio, tools | $0.25 / $1.50 |
| qwen3-235b | 262K / 16K | tools | $0.25 / $1.00 |
| vertex-gemini-2.5-pro | 1.0M / 66K | vision, pdf, audio, tools | $1.25 / $10.00 |
| vertex-gemini-2.5-flash | 1.0M / 66K | vision, pdf, tools | $0.30 / $2.50 |
| claude-opus-4-7 | 1.0M / 128K | vision, pdf, tools | $5.00 / $25.00 |
| claude-sonnet-4-6 | 1.0M / 64K | vision, pdf, tools | $3.00 / $15.00 |
| claude-haiku-4-5 | 200K / 8K | vision, pdf, tools | $1.00 / $5.00 |

**In Prüfung** (Evaluation durch das KI-Team läuft):

| Modell | Status |
|---|---|
| codestral-2 | 🟡 Prüfung |
| mistral-medium-3 | 🟡 Prüfung |

Die Liste wird zentral durch das KI-Team gepflegt. Neue Modelle werden nach interner Evaluation freigeschaltet.

---

## Architektur, Datenschutz & Kostenzuordnung

Alle Modelle laufen über die **Google Cloud Platform (GCP)** Umgebung von OPEN. Anfragen werden im Gateway automatisch dem GCP-Projekt der jeweiligen Unit zugeordnet, in der der Benutzer arbeitet.

**GCP-Projekt-Ownership pro Unit:**

| Unit | Ansprechpartner |
|---|---|
| CX | Elias Dreisbach |
| ADX | Jens Parree |
| SC | Andreas Hucks |

**Authentifizierung** bei [https://ai.open.de](https://ai.open.de) erfolgt durchgängig über **Google SSO**.

---

## Für End User — AI Studio im Browser oder Claude Desktop App

> Diese Sektion richtet sich an alle Mitarbeitenden, die Sprachmodelle **interaktiv** nutzen wollen — entweder im **AI Studio** auf ai.open.de (eigene OPEN-Oberfläche mit Chat & Agents) oder über die **Claude Desktop App** (offizieller Anthropic-Client, der seine Anfragen über das AI.OPEN Gateway routet).

> **⚠️ Wichtig — Claude im Browser geht nicht über AI.OPEN**
>
> Die offizielle Claude-Weboberfläche auf [claude.ai](https://claude.ai) unterstützt **kein** Custom Gateway. Wer Claude direkt nutzen will, muss die **Claude Desktop App** installieren (siehe Variante B) — nur dort lässt sich das AI.OPEN Gateway konfigurieren.

### Variante A: AI Studio im Browser auf ai.open.de

1. Öffne [https://ai.open.de](https://ai.open.de) und logge dich via Google SSO ein.
2. Wähle im Chat den gewünschten Agent oder das Modell aus.
3. Dein aktueller Token-Verbrauch wird dir jederzeit in der Menüleiste angezeigt.

#### Custom Agents nutzen

Unter [https://ai.open.de/agents](https://ai.open.de/agents) findest du vom KI-Team bereitgestellte Custom Agents. Diese kombinieren Sprachmodelle mit hinterlegten **Wissensquellen** und **Integrationen** zu anderen Systemen, um konkrete Use Cases abzubilden — z.B. Angebotsgenerierung, Kundenanalyse oder Call-Transkripte.

> **⚠️ Wichtig — Custom Agents sind kein ChatGPT-Ersatz**
>
> Die Custom Agents auf ai.open sind für **klar abgegrenzte Use Cases** gebaut (z.B. OPEN PULSE für Kundenanalyse). Sie ersetzen **nicht** generelle KI-Assistenten wie ChatGPT oder Claude für den Alltag.
>
> Für allgemeine KI-Nutzung (Recherche, Texten, Brainstorming, allgemeine Fragen) verwende stattdessen den **Claude Desktop Client mit AI.OPEN** (siehe Variante B unten) — dort hast du Zugriff auf alle Sprachmodelle als vollwertiger Chat-Assistent, datenschutzkonform und mit Budget-Zuordnung.

**Aktuell verfügbare Agents:**

| Agent | Use Case | Hauptansprechpartner |
|---|---|---|
| **OPEN PULSE** | Kundenanalyse | Robert Schaperjahn |

→ Neue Agent-Ideen oder Mitentwicklung gewünscht? Siehe [Ansprechpartner](#ansprechpartner--wer-macht-was).

### Variante B: Claude Desktop Client mit AI.OPEN

Um den Claude Desktop Client ([https://claude.com/download](https://claude.com/download)) datenschutzkonform und mit Budget-Zuordnung über AI.OPEN zu betreiben:

1. **Claude Desktop App** öffnen.
2. In der Menüleiste: **Help → Troubleshooting → Enable Developer Mode**.
3. App führt einen Restart durch.
4. Es erscheint ein neuer Menüpunkt **Developer → Configure Third Party Inference**.
5. **Connection** auf `Gateway` setzen.
6. **Credential Kind**: `Static API Key`.
7. **Gateway Base URL**:
   ```
   https://backend.ai.open.de/litellm/<PROJECT_ID>
   ```
   `<PROJECT_ID>` ersetzen durch entweder `DEFAULT` (kein Projekt zugeordnet) oder die Projekt-ID aus [https://ai.open.de/projects](https://ai.open.de/projects).
8. **Gateway API Key**: dein persönliches Token von [https://ai.open.de/token](https://ai.open.de/token).
9. Auf **Test model discovery** klicken — sollte z.B. liefern:
   ```
   Model discovery — found 3 models
   claude-opus-4-7*, claude-sonnet-4-6*, claude-haiku-4-5*
   ```
10. **Apply Changes**. Fertig.

---

## Prompts & Skills Library — zentrale Wiederverwendung

> AI.OPEN bietet zwei zentrale Bibliotheken, mit denen Prompts und Skills **team-übergreifend** verwaltet, versioniert und geteilt werden — statt sie in lokalen Notizen oder Chat-Verläufen zu verstecken.

### Prompts Library

**URL:** [https://ai.open.de/prompts](https://ai.open.de/prompts)

Die Prompt Library erlaubt das **Erstellen, Organisieren und Deployen von Prompts** über die gesamte KI-Infrastruktur hinweg.

**Features:**
- **Folders** für thematische Gruppierung (z.B. `Coding`, `Sales`)
- **Public / Private Sichtbarkeit** pro Prompt
- **Versionierung** — frühere Stände bleiben erhalten
- **Variablen** — Prompts werden zu wiederverwendbaren Templates (z.B. der `OPEN Pulse Report` Prompt mit 7 Variablen)
- **Agent-Zuweisung** — Prompts direkt einem oder mehreren Agents zuweisen
- **Likes & Feedback** — gute Prompts werden im Team sichtbar

**Typische Use Cases:**
- Master-Prompts für Standard-Reports (z.B. `OPEN Pulse Report`)
- Commit-Message-Generierung für Coding-Workflows
- Wiederverwendbare Sales-Prompts (Angebotsanschreiben, Kunden-Reverse-Engineering)
- Dokumentations-Generatoren

### Skills Library

**URL:** [https://ai.open.de/skills](https://ai.open.de/skills)

Die Skills Library erlaubt das **Bauen, Versionieren und Verwalten von wiederverwendbaren Skill-Paketen** für AI Agents.

**Features:**
- **Versionierung** (v1, v2, …) — Skills entwickeln sich kontrolliert weiter
- **Public / Private Sichtbarkeit**
- **SKILL.md Format** — Skills werden als Markdown-Pakete beschrieben (was sie tun, wann sie anzuwenden sind)
- **Direkt nutzbar** in den Custom Agents der Agents-Library

**Vorteil:** Skills einmal bauen, in mehreren Agents nutzen — ohne Copy-Paste oder Drift zwischen Implementierungen.

### Wann nutze ich was?

| Du willst… | … nutze |
|---|---|
| Einen häufig wiederkehrenden Text-Baustein zentral pflegen | **Prompts Library** |
| Eine fachliche Vorlage für mehrere Kollegen teilen | **Prompts Library** |
| Einen wiederverwendbaren "Skill" (z.B. spezifische Analyse-Methode) für mehrere Agents zur Verfügung stellen | **Skills Library** |
| Einen kompletten Use Case (Modell + Wissensquellen + Skills) als Anwendung bauen | **Custom Agents** ([ai.open.de/agents](https://ai.open.de/agents)) |

---

## Für Developer — Sprachmodelle in Coding-Tools

> Diese Sektion richtet sich an Developer, die Sprachmodelle in IDEs und Agentic-Coding-Tools wie **Claude Code** oder **continue.dev** einsetzen wollen.

### Grundlagen: OpenAI-kompatible Endpunkte

Die meisten Coding-Tools und IDE-Integrationen sprechen die OpenAI-API. AI.OPEN stellt dafür einen kompatiblen Endpunkt bereit:

```
https://backend.ai.open.de/litellm/<PROJECT_ID>/v1/
```

**Projekt-Zuordnung:** `<PROJECT_ID>` ersetzen durch:
- `DEFAULT` — wenn kein Projekt zugeordnet werden soll, oder
- die **Projekt-ID** aus [https://ai.open.de/projects](https://ai.open.de/projects) (üblicherweise der Kunde, für den die KI-Nutzung erfolgt).

> Die Projekt-Zuordnung ist **entscheidend für das Kosten-Controlling** — bitte immer das richtige Projekt setzen, sobald für einen konkreten Kunden gearbeitet wird.

### Authentifizierung

Zwei Methoden stehen zur Verfügung:

| Methode | Wo erstellen? | Wie verwenden? | Einsatzzweck |
|---|---|---|---|
| **Persönliches Token** (user-bezogen) | [https://ai.open.de/token](https://ai.open.de/token) | Header: `Authorization: Bearer <token>` | Default für IDE-Integrationen |
| **API Key** (anwendungsbezogen) | [https://ai.open.de/keys](https://ai.open.de/keys) | Header: `exulu-api-key: <key>` | Für Anwendungen / Services |

---

### Setup: Claude Code

Um Claude Code via den AI.OPEN Gateway zu nutzen, lege folgende `settings.json` im `.claude` Ordner an (typischerweise im Repository-Root):

```json
{
  "model": "claude-opus-4-7",
  "availableModels": [
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-7"
  ],
  "env": {
    "ANTHROPIC_BASE_URL": "https://backend.ai.open.de/litellm/<PROJECT_ID>",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": 1,
    "DISABLE_AUTOUPDATER": 0
  },
  "apiKeyHelper": "echo <MY_TOKEN>"
}
```

**Ersetzen:**
- `<PROJECT_ID>` → `DEFAULT` oder Projekt-ID aus [https://ai.open.de/projects](https://ai.open.de/projects).
- `<MY_TOKEN>` → dein Token aus [https://ai.open.de/token](https://ai.open.de/token).

Bei `model` und `availableModels` können prinzipiell alle Modelle aus AI.OPEN gelistet werden (z.B. `vertex-gemini-3.5-flash`, `qwen3-235b`, `gemini-3.1-flash-lite`, `vertex-gemini-2.5-flash`, `vertex-gemini-2.5-pro` usw.).

Danach funktioniert Claude Code genauso wie bei direkter Anthropic-Authentifizierung — nur eben über das AI.OPEN Gateway mit korrekter Kostenzuordnung.

---

### Setup: continue.dev

#### Plugin installieren

**JetBrains (PhpStorm, IntelliJ etc.):**
1. Settings öffnen (`Cmd+,` / `Ctrl+Alt+S`)
2. Im linken Menü zu **Plugins** navigieren
3. Im Marketplace nach **Continue** suchen
4. **Install** klicken
5. IDE ggf. neu starten

Das Plugin erscheint anschließend in der rechten Sidebar oder im Tools-Menü.

**Visual Studio Code:**
1. Extensions-Ansicht öffnen (`Cmd+Shift+X` / `Ctrl+Shift+X`)
2. Nach **Continue** im Marketplace suchen
3. **Install** klicken

Das Continue-Icon erscheint nun in der linken Aktivitätsleiste.

#### `config.yaml` konfigurieren

So öffnest du die Konfigurationsdatei:
1. Auf das **Continue-Icon** rechts oben (bzw. im Sidebar-Panel) klicken
2. Auf das **Zahnrad-Icon** (Settings) klicken
3. Links **Configs** wählen
4. Hinter dem Eintrag **Local Config** auf das Zahnrad-Icon klicken

Anschließend folgenden Eintrag in die `config.yaml` einfügen:

```yaml
name: Local Config
version: 1.0.0
schema: v1
models:
  - name: AI.OPEN
    provider: openai
    apiBase: https://backend.ai.open.de/litellm/<PROJECT_ID>/v1
    apiKey: <TOKEN>
    model: AUTODETECT
    roles:
      - chat
      - edit
      - apply
    capabilities:
      - tool_use
      - image_input
```

**Ersetzen:**
- `<PROJECT_ID>` → `DEFAULT` oder Projekt-ID
- `<TOKEN>` → dein Token aus [https://ai.open.de/token](https://ai.open.de/token)

Nach dem Speichern erkennt die IDE den neuen Provider automatisch. Alle Projekte erscheinen als Modelle in continue, die Modell-Namen sind nach dem Schema `Projekt/Agent` aufgebaut — dadurch wird der Token-Verbrauch sauber auf die jeweiligen Projekte gebucht.

**Happy Coding mit continue!**

---

## Für Admins & Team-Leads — Budgets, User & Controlling

> Diese Sektion richtet sich an **KI-Leads** der Units sowie an **Super-Admins** des KI-Teams.

### Token-Budgets

- **Default-Budget pro Benutzer:** 20 USD / Monat
- **OPEN-weites maximales Monatsbudget pro User:** 3.500 USD (System blockiert automatisch bei Überschreitung)
- **Sichtbarkeit für User:** jeder Benutzer sieht seinen aktuellen Verbrauch in der AI.OPEN Menüleiste

### Budget-Verwaltung

Admins und Team-Leads können unter [https://ai.open.de/budgets](https://ai.open.de/budgets) individuell pro Benutzer die Budgets erhöhen.

| Aktion | Zuständig |
|---|---|
| Budget-Anpassung **innerhalb** des Teams (bis 3.500 USD/Monat) | KI-Lead der Unit |
| Budget-Erhöhung **über** das OPEN-weite Maximum (3.500 USD/Monat) | KI-Team — Entscheidung muss dort getroffen werden |

Budgets können pro **User, Role, Team, Project oder Agent** gesetzt werden — durchgesetzt werden sie durch LiteLLM auf Basis der jeweiligen Entity-Nutzung.

### Controlling & Reporting

**Super-Admins** haben Zugriff auf das Controlling-Backend unter:
[https://backend.ai.open.de/litellm-admin/ui/](https://backend.ai.open.de/litellm-admin/ui/)

Dort können pro **Projekt, Benutzer, Rolle und Team** Daten exportiert werden, die eine genaue Zuordnung des Token-Verbrauchs für Controllingzwecke ermöglichen.

Alle Aufrufe über AI.OPEN werden automatisch mit **Projekt-, Rollen-, Benutzer- und Team-Tags** versehen. Diese erlauben das Filtern der Kostenzuordnung im Reporting.

**Export & Filterung:**
[https://backend.ai.open.de/litellm-admin/ui/?page=new_usage](https://backend.ai.open.de/litellm-admin/ui/?page=new_usage)

→ **Usage View** auf **Tag Usage** wechseln, dann entweder exportieren oder nach spezifischen Tags vorfiltern.

> **⚠️ Wichtig:** Durch einen Bug im LiteLLM-Proxy werden in der Tag-Ansicht Kosten **doppelt gezählt**, weil dieselben Kosten mit mehreren Tags (z.B. Projekt + User) gerechnet werden. Dies ist beim CSV-Export entsprechend zu berücksichtigen.

---

## Roadmap & Vision

AI.OPEN ist die strategische Plattform für sämtliche KI-Nutzung bei OPEN. Das KI-Team pflegt eine Roadmap an **Custom Agents**, die schrittweise verfügbar gemacht werden.

**In der nahen Zukunft geplant:**

1. **Ausschreibungs-Agent** — Unterstützung im Ausschreibungsprozess
2. **Projekt-Management-Agent** — Begleitung im Projektalltag
3. **Marketing-Support-Agent** — Unterstützung für das Marketing-Team

**Mittelfristige Vision:**
- Konsolidierung **aller** KI-Use-Cases bei OPEN unter einer einheitlichen, datenschutzkonformen Plattform
- Saubere Kostenzuordnung pro Kunde, Projekt und Unit
- Self-Service für Teams beim Anlegen eigener Agents und Wissensquellen

---

## Ansprechpartner — Wer macht was?

### 💬 Zentraler Austausch · Google Chat

Alle wichtigen Diskussionen, Updates und Fragen rund um AI.OPEN laufen über den **Google Chat Kanal**:

→ [https://chat.google.com/u/0/app/chat/AAAAKWkq6-k](https://chat.google.com/u/0/app/chat/AAAAKWkq6-k)

Tritt dem Kanal bei — dort werden neue Modelle, neue Agents, Roadmap-Updates und Best Practices geteilt.

### KI-Leads pro Unit

Der **KI-Lead** ist die erste Anlaufstelle innerhalb deiner Unit für alles rund um AI.OPEN — insbesondere für **Budget-Anpassungen** innerhalb des Teams.

| Unit | KI-Lead |
|---|---|
| **ADX** | patrick.dyckerhoff@open.de |
| **CX** | sergej.keterling@open.de |
| **SC** | andreas.hucks@open.de |
| **ST** | alexander.stevenson@open.de & nils.heine@open.de |

### Weitere Ansprechpartner

| Anliegen | Ansprechpartner |
|---|---|
| **Allgemeine AI.OPEN Fragen, neue Agent-Ideen, Mitentwicklung** | Daniel Claessen, Michael Möckel |
| **OPEN PULSE (Kundenanalyse-Agent)** | Robert Schaperjahn |
| **Budget-Erhöhung innerhalb eines Teams** | KI-Lead der jeweiligen Unit (siehe oben) |
| **Budget-Erhöhung über OPEN-weites Maximum (3.500 USD)** | KI-Team |
| **GCP-Projekt CX** | Elias Dreisbach |
| **GCP-Projekt ADX** | Jens Parree |
| **GCP-Projekt SC** | Andreas Hucks |
| **Controlling-Exports & Reporting** | Super-Admins / KI-Team |

---

*Dieser Guide wird regelmäßig aktualisiert. Letzte Aktualisierung: 12.06.2026.*
