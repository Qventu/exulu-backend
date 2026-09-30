# Newlift memory recall regression — re-run with the cited-memory gate (2026-09-30)

Gate revision: spec §6.1 (2026-09-30) — Stage 1 = memories the verified answer cited (live ids), ≥ 80 % of cited
cases at Newton's limit 25; Stage 2 = LLM judge mean ≥ 70 excluding approval-paused "remember this" turns, no cited
case below 50. Build under test: `feat/agent-memory` d6a6ddc (conversation-aware recall query, Task 6b). Replay by
`scripts/memory-eval/run-cases.ts` (newlkiag c100965) through `POST /agents/litellm/run/<agent>`; judge
`vertex-gemini-3.8-flash` via LiteLLM, concurrency 5, 58 s. Newton's `memory_config` set to limit 25 and left there.

The replay was run by the Task 8c agent (73 cases = 52 cited + 21 latest non-cited, 105 model turns, 1 error:
`1a0356cd` 500 fetch failed). The judging and this report were completed by the controller after the session
restart of 2026-09-30 (the agent's run was interrupted by a process fan-out that locked the machine).

---

## report.ts output (verbatim)

# Newlift memory regression eval (rerun)

Date: 2026-09-30 · cases: 72 (cited 52, non-cited 20, errors 1) · judge: vertex-gemini-3.8-flash

## Stage 1 — are the memories the verified answer cited recalled?

Ground truth: the memory ids in the verified answer's citation objects (`context: newton_memory_context` or the
older alias `context: memory`), restricted to ids that still exist. A case hits when **every** such id is in
`recalledMemories`.

Hit rate: **80.8 %** (42/52). Gate ≥ 80 %: PASS

Per item: 62/76 = 81.6 % of cited memories recalled.

### Cited cases

| case | question | cited | hit | missing memories | score |
| --- | --- | --- | --- | --- | --- |
| 068ce1e1 | Gibt es das Meiller Türsteuergerät MDD6 nur mit CAN-Bus oder auch mit digitalen | 1 | ✓ | — | 85 |
| 18298553 | sorry, ich meinte 000048F2 | 1 | ✓ | — | 85 |
| 47baf6e8 | sorry, ich meinte 000048F2 | 1 | ✓ | — | 85 |
| 18c8ac50 | Was muss ich an der FST-2XT einstellen, wenn ich eine Lastwiegeeinrichtung über | 1 | ✓ | — | 70 |
| 17b55f0a | Was bedeutet die Debug Anzeige SRC: 00 00 01 02 00 | 2 | ✓ | — | 90 |
| 34daba73 | Wie wird diese funktion an der FST abgefragt? | 1 | ✓ | — | 50 |
| 9e67e276 | auf englisch bitte | 3 | ✓ | — | 100 |
| 2e313733 | an der FST-2XT zählt der Pwert nicht während der fahrt, es wird eine Elgo limax | 1 | ✓ | — | 75 |
| 66da87bb | welche CBM Module entsprechem dem neusten Hard und Softwarestand? | 1 | ✓ | — | 70 |
| be02d628 | Benötige ich für die Einbindung eines A3 230V absperrt Ventil eine FST2XT mit UC | 1 | ✓ | — | 100 |
| 21d1b71a | wie führe ich bei der FST-3 einen fangtest durch? | 1 | ✓ | — | 80 |
| 03af8a7d | Türantrieb wechsel CAN Ansteuerung für Meiller MDD6 funktioniert nicht, vorher w | 1 | ✓ | — | 50 |
| 4c5da8f9 | Welche bekannten Gründe gibt es wenn der Fehler nicht richtig auslöst? | 1 | ✗ | FST-3 Teaching Positions | 75 |
| c0978411 | Wie kann man die Notentriegelung reseten | 1 | ✓ | — | 45 |
| 6e680483 | Bei der FST2+3, Aussenrufe, ADM module funktionieren nicht! | 1 | ✗ | Troubleshooting ADM - External Call Issues | 85 |
| e0ff22cf | Bei einem Algi Smartpack mit AZRS fährt der Aufzug normal hoch und beim runterfa | 3 | ✓ | — | 88 |
| e901cdd9 | FST2XT mit (Fuji) Frequenzumrichter hat einen LSU-Antriebsfehler | 2 | ✓ | — | 100 |
| 35ac434e | Bitte Antwort 3.,4.,5. bei dieser Frege nicht mehr bringen sind falsch! Der häuf | 1 | ✓ | — | 0 |
| f71afc87 | Betrifft FST2+3, kannst du mir eine Auflistung der Parameter im Factory menü, Ve | 5 | ✗ | Kalibrierfahrt Endschalter bei kurzem Schacht (FST-2XT, FST-2, FST-3); FST-2XT Zwangsschließen durch Lichtschrankenfehler; LS und RS Bedeutung in FST Tür Parametern | 50 |
| 8be51b0b | Brandfall vom ADM/EAZ soll beide Tür Seiten öffnen bei einer FST-2XT | 1 | ✗ | Miscel-15 Bit-0: Tür-Auf-Kopplung im Feuerwehrmodus | 25 |
| fb95867a | Kannst Du mir eine vollständige Liste der Parameter des Untermenüs FEUERWEHROPTI | 1 | ✓ | — | 60 |
| 6cbae212 | Suche nach allen Miscel-D2 Bits | 1 | ✓ | — | 55 |
| 91165dc5 | Umrichter meldet STO fehler und Steuerung meldet LSU-Bremse Fehler | 1 | ✓ | — | 65 |
| 2d27114a | Merke Dir: bei der Frage Bypass funktioniert nicht , solltest du alle diese Antw | 3 | ✓ | — | skipped |
| c2261d86 | Wenn es keine CAN Türe ist, was kann es noch sein? | 2 | ✓ | — | 95 |
| 9a35d1ac | was kann der Grund sein, wenn bei einem MDD6 Can der Türstand nicht angezeigt wi | 2 | ✓ | — | 45 |
| 1e336fef | Bypass funktioniert nicht | 1 | ✓ | — | 85 |
| 8827260a | Merke dir: 1.Hängekabel ist falsch, das Hängkabel hat nicht mit den Bremskontakt | 1 | ✓ | — | skipped |
| 841aaf8f | Merke dir: 1.Hängekabel ist falsch, das Hängkabel hat nicht mit den Bremskontakt | 1 | ✓ | — | skipped |
| db61e5f4 | Ich glaube die aktuelle FST-2XT Softwareversion lautet V0195! | 1 | ✓ | — | 95 |
| 29704bd0 | Welche Ursachen gibt es wenn die FST-3 im Montagemodus das SHK-Relay nicht schli | 1 | ✓ | — | 85 |
| 3149e024 | Welche Gründe kann es bei der FST-2XT geben, dass die Fahrkorbtüre manchmal nich | 1 | ✗ | Tür öffnet nicht - Endschalter | 80 |
| 1fd2a79b | FST2+3, Acht Tonnen Aufzug, jedes mal wenn der Stabler mit Gesamtgewicht 7,5 ton | 1 | ✓ | — | 85 |
| a5af5f43 | CBM2  gibt keine Spannung am Bremsausgang | 3 | ✗ | CBM CAN Fehler 0xFF0C; Wichtige Informationen zu CBM-2 Unterstromfehler in Ticket TC240471 | 65 |
| 62449928 | Die DCP Verbindung scheint nicht in Ordnung zu sein. Masse Verbindung der Verbin | 1 | ✓ | — | 0 |
| f23494f5 | FST-2XTs, Nach TÜV Abnahme nach jeder Fahrt einen LSU-Zone Fehler. | 1 | ✓ | — | 90 |
| 44b361f5 | Merke noch zusätzlich beim Fehler S2-Traktion folgendes: S2-Software update auf | 2 | ✓ | — | 0 |
| c41334b9 | Merke noch zusätzlich beim Fehler S2-Traktion folgendes: S2-Software update auf | 2 | ✓ | — | 0 |
| 6e181022 | FST2+3 geht auf Störung Bremsüberwachung. Die Spannung an der Bremskontakteingän | 2 | ✗ | Wichtige Informationen zu CBM-2 Unterstromfehler in Ticket TC240471; Half-Wave Mode Bremsspannungsprobleme | 55 |
| 17d8df08 | Als zusätzliche Antwort hinzufügen: Haben eventuell die Vorendschalter geschalte | 1 | ✗ | Schachtgruben-Inspektion Reset Morsecode (neuere Methode) | 0 |
| 3caf700e | Als zusätzliche Antwort hinzufügen: Haben eventuell die Vorendschalter geschalte | 1 | ✗ | Schachtgruben-Inspektion Reset Morsecode (neuere Methode) | 0 |
| 107c7e94 | Merke dir, wenn Türendschalter -JA eingestellt ist und der Enschalter-Auf nicht | 1 | ✓ | — | skipped |
| eb1f6a84 | Merke dir, wenn Türendschalter -JA eingestellt ist und der Enschalter-Auf nicht | 1 | ✓ | — | skipped |
| 601efa06 | Bitte nochmal überlegen: Etage 02 und Geschwindigkeit ve! | 2 | ✓ | — | 0 |
| 90f9d60a | Die FST3 bring ab und zu den Fehler LSU-UCM02 könnte es ein Software Bug sein, g | 1 | ✓ | — | 85 |
| 42b07a5b | Was sind die englischen Abkürzungen für Fahrkorb und Ruftableaus? | 1 | ✓ | — | 90 |
| 67af1253 | Bei der FST2XT, Kabinentüre öffnet nicht beim unterbrechen der Lichtschranke | 3 | ✓ | — | 80 |
| 45ccba17 | Was könnten weitere Uraschen neben EMV und Bremswartezeit sein bei CAN-Open? | 1 | ✓ | — | 50 |
| ea7ec983 | ich habe eine Kalibrierfahrt gemacht und der Aufzug ist langsam in den Endschalt | 2 | ✓ | — | 85 |
| 4f9e1821 | was muss man bei der FST-2XT einstellen, damit eine zu lange unterbrochene Licht | 2 | ✗ | LS und RS Bedeutung in FST Tür Parametern | 50 |
| 9e1343de | Wie lautet die aktuelle Softwareversion des CBM2? | 1 | ✓ | — | 100 |
| bbb44ef4 | Was bedeutet bei der FST2XT der Türfehler  LSU Türe 130 | 1 | ✓ | — | 100 |

### Misses in full

- MISS 4c5da8f9 · Q: Welche bekannten Gründe gibt es wenn der Fehler nicht richtig auslöst?
  missing: FST-3 Teaching Positions (e98bf14b)
  recalled 25: Tür öffnet nicht - Endschalter | LSU Fang/GB Falschauslösung - Port Entprellung | FST-2XT Zwangsschließen durch Lichtschrankenfehler | S2-UCM-Fehler FST3 | Absinkschutz Fehlerdetails | Troubleshooting Drive Watchdog Fehler | Half-Wave Mode Bremsspannungsprobleme | Fahrkorbtür schließt nicht: Motor-ZU/K2 aktiv -> Türsteuergerät | Falsche Verdrahtung des Sicherheitskreises bei FST2XT | Sperrmittel Anzeige und Lichtschranke | LSU-Motor-Fehler Eigenschaft | Kritische LSU-Tür Fehler und Systemstillstand | Wichtige Informationen zu CBM-2 Unterstromfehler in Ticket TC240471 | Regler Error 532 is occuring with FST and Ziehl-abbeg frequency inverter in CANopen drive mode | ASV Fehler Doku | LSU A3 Antriebsfehler Unterscheidung | Türendschalter JA und fehlender Endschalter-Auf blockiert Türschließung | LSU-Antriebsfehler Testverfahren iValve | Fehlerspeicher Frequenzumrichter prüfen bei LSU-Antriebsfehler | FST2/3 Sporadische Inspektion durch EMV / Motorschirm | FST-2XT Fehler 15 LSU Seilschlupf | Bypass funktioniert nicht - FST-2 / FST-3 Fehlerquellen und Lösungen | Schalter S14 bei Fernabschaltung (FST-2XT) | FST-2XT KEIN FEHLER Anzeige-Bedeutung | Riegelfehler Ursachen (Schachttür / Sperrmittelschalter)
- MISS 6e680483 · Q: Bei der FST2+3, Aussenrufe, ADM module funktionieren nicht!
  missing: Troubleshooting ADM - External Call Issues (65573253)
  recalled 25: CUS-CQ Dokumentation | FST-2XT LON-Bus Optimierung | FST-2XT Etagen sperren | LSU A3 Antriebsfehler Unterscheidung | Schachtgruben-Inspektion Reset Morsecode (neuere Methode) | Türendschalter JA und fehlender Endschalter-Auf blockiert Türschließung | FST-2 auf FST-2XT Tausch: Stecker X13 und Brücke 7-14 | Fehlerspeicher Frequenzumrichter prüfen bei LSU-Antriebsfehler | UCM Fehler durch veraltete FST3 Software | LSU-Zwangshalt bei DB-Anlagen durch TDF-Modul | FST2/3 Sporadische Inspektion durch EMV / Motorschirm | Montagefahrt ohne K50.1/2 und Absinkschutz-Rückmeldung (FST-3 / S2) | FST-2XT Absinkschutz bei Inspektion | Korrektur: CANopen Tür-Initialisierung A+B und Bypass-Verhalten | Bremskontakte Verdrahtung und Hängekabel | Bypass funktioniert nicht - FST-2 / FST-3 Fehlerquellen und Lösungen | Limax2M Geberwert ändert sich nicht - Jumper-Einstellungen | Diagnosehinweis Riegelmagnet und Riegelkurve | FST-2XT / GST-XT Umbau: Selektivruf-Fehlerbehebung bei alten EAZ-Modulen | FST-3 S2 UCM-A3 Test ohne ASS SBR Relais Verhalten | FST-2XT KEIN FEHLER Anzeige-Bedeutung | FSM-2 Jumperstellung bei CAN-Bus Türantrieb (Bypass-Betrieb) | FST-2XT Absolutwertkopierung Auflösung berechnen | FST-2XT DCP03 Stillstanderkennung Schalter-4 bei älteren Umrichtern | Inkrementalgeber Orientierung überblendet Überlast
- MISS f71afc87 · Q: Betrifft FST2+3, kannst du mir eine Auflistung der Parameter im Factory menü, Versteckte Menüs machen
  missing: Kalibrierfahrt Endschalter bei kurzem Schacht (FST-2XT, FST-2, FST-3) (571052d8), FST-2XT Zwangsschließen durch Lichtschrankenfehler (6133c18b), LS und RS Bedeutung in FST Tür Parametern (edfc9649)
  recalled 25: FST-2XT Kalibrierfahrt - Kurzer Schacht | FST-2XT LON-Bus Optimierung | FST-2XT Etagen sperren | FST-2XT Inspektion FK Display-Reset | Einfahrgeschwindigkeit Translation FST-2XT | Türendschalter JA und fehlender Endschalter-Auf blockiert Türschließung | FST-2 auf FST-2XT Tausch: Stecker X13 und Brücke 7-14 | Fehlerspeicher Frequenzumrichter prüfen bei LSU-Antriebsfehler | FST2/3 Sporadische Inspektion durch EMV / Motorschirm | Montagefahrt ohne K50.1/2 und Absinkschutz-Rückmeldung (FST-3 / S2) | FST-2XT Absinkschutz bei Inspektion | Bypass funktioniert nicht - FST-2 / FST-3 Fehlerquellen und Lösungen | Elevision 4.0 Fernbedienung / Bedienen ohne Funktion (FST Parameter E4-Live-Bedienen ab V0184) | Limax2M Geberwert ändert sich nicht - Jumper-Einstellungen | Diagnosehinweis Riegelmagnet und Riegelkurve | FST-2XT / GST-XT Umbau: Selektivruf-Fehlerbehebung bei alten EAZ-Modulen | Priorisierung antriebsregler.txt für FST-2XT Vorsteuerrelais | Absinkschutz Abfallverzögerung an Schneider-Schützen anpassen | Miscel-4 Bit-0 (00000001): Türen bei Fernabschaltung offenhalten | FST-3 S2 UCM-A3 Test ohne ASS SBR Relais Verhalten | FST-2XT KEIN FEHLER Anzeige-Bedeutung | Laufzeitüberwachung (LSU) Parametrierung | Laufzeitüberwachung (LSU) Auslösekriterien | FST-2XT DCP03 Stillstanderkennung Schalter-4 bei älteren Umrichtern | CBM2 Parametrierung über CAN an FST-2XT
- MISS 8be51b0b · Q: Brandfall vom ADM/EAZ soll beide Tür Seiten öffnen bei einer FST-2XT
  missing: Miscel-15 Bit-0: Tür-Auf-Kopplung im Feuerwehrmodus (270a28b6)
  recalled 25: FST-3 and FST-2XT E/A-Port Functionality | FST-2XT Zwangsschließen durch Lichtschrankenfehler | Falsche Verdrahtung des Sicherheitskreises bei FST2XT | FST-2XT Etagen sperren | FST-2XT Inspektion FK Display-Reset | Türendschalter JA und fehlender Endschalter-Auf blockiert Türschließung | FST-2 auf FST-2XT Tausch: Stecker X13 und Brücke 7-14 | Vorendschalter-Prüfung Schachtgruben-Inspektion FST2/3 | CANopen Tür-Initialisierung A+B und Bypass-Verhalten | FST-2XT Absinkschutz bei Inspektion | Wittur CAN Türantrieb Kompatibilität mit FST | Korrektur: CANopen Tür-Initialisierung A+B und Bypass-Verhalten | Bypass funktioniert nicht - FST-2 / FST-3 Fehlerquellen und Lösungen | Schalter S14 bei Fernabschaltung (FST-2XT) | Diagnosehinweis Riegelmagnet und Riegelkurve | FST-2XT / GST-XT Umbau: Selektivruf-Fehlerbehebung bei alten EAZ-Modulen | Priorisierung antriebsregler.txt für FST-2XT Vorsteuerrelais | Absinkschutz Abfallverzögerung an Schneider-Schützen anpassen | Miscel-4 Bit-0 (00000001): Türen bei Fernabschaltung offenhalten | FST-2XT KEIN FEHLER Anzeige-Bedeutung | FSM-2 Jumperstellung bei CAN-Bus Türantrieb (Bypass-Betrieb) | Miscel-1 Bit-5: Türen offenhalten nach LSU-Fehler | FST-2XT Etage 07 sperren und mit Innen-Prio befahren | FST-2XT DCP03 Stillstanderkennung Schalter-4 bei älteren Umrichtern | CBM2 Parametrierung über CAN an FST-2XT
- MISS 3149e024 · Q: Welche Gründe kann es bei der FST-2XT geben, dass die Fahrkorbtüre manchmal nicht öffnet und es keinen Eintrag im Fehler
  missing: Tür öffnet nicht - Endschalter (858dae68)
  recalled 25: Fahrkorbtür schließt nicht: Motor-ZU/K2 aktiv -> Türsteuergerät | FST-2XT Etagen sperren | FST-2XT Inspektion FK Display-Reset | Türendschalter JA und fehlender Endschalter-Auf blockiert Türschließung | LSU-Antriebsfehler Testverfahren iValve | FST-2 auf FST-2XT Tausch: Stecker X13 und Brücke 7-14 | Vorendschalter-Prüfung Schachtgruben-Inspektion FST2/3 | Fehlerspeicher Frequenzumrichter prüfen bei LSU-Antriebsfehler | UCM Fehler durch veraltete FST3 Software | FST2/3 Sporadische Inspektion durch EMV / Motorschirm | FST-2XT Absinkschutz bei Inspektion | FST-2XT Fehler 15 LSU Seilschlupf | Bypass funktioniert nicht - FST-2 / FST-3 Fehlerquellen und Lösungen | Limax2M Geberwert ändert sich nicht - Jumper-Einstellungen | Schalter S14 bei Fernabschaltung (FST-2XT) | Diagnosehinweis Riegelmagnet und Riegelkurve | FST-2XT / GST-XT Umbau: Selektivruf-Fehlerbehebung bei alten EAZ-Modulen | Absinkschutz Abfallverzögerung an Schneider-Schützen anpassen | Miscel-4 Bit-0 (00000001): Türen bei Fernabschaltung offenhalten | FST-2XT KEIN FEHLER Anzeige-Bedeutung | Miscel-1 Bit-5: Türen offenhalten nach LSU-Fehler | FST-2XT Absolutwertkopierung Auflösung berechnen | FST-2XT Etage 07 sperren und mit Innen-Prio befahren | FST-2XT DCP03 Stillstanderkennung Schalter-4 bei älteren Umrichtern | Inkrementalgeber Orientierung überblendet Überlast
- MISS a5af5f43 · Q: CBM2  gibt keine Spannung am Bremsausgang
  missing: CBM CAN Fehler 0xFF0C (e294c0ae), Wichtige Informationen zu CBM-2 Unterstromfehler in Ticket TC240471 (65914649)
  recalled 14: FST-2XT Inspektions-Haltepunkte | Absinkschutz Fehlerdetails | FST-1 Schachtkopierung Alternativen | Half-Wave Mode Bremsspannungsprobleme | Schachtgruben-Inspektion Reset Morsecode (neuere Methode) | Türendschalter JA und fehlender Endschalter-Auf blockiert Türschließung | Elevision 4.0 Fernbedienung / Bedienen ohne Funktion (FST Parameter E4-Live-Bedienen ab V0184) | Diagnosehinweis Riegelmagnet und Riegelkurve | CBM2 Bremsenbetrieb mit 24V | FST-2XT KEIN FEHLER Anzeige-Bedeutung | CBM2 Fehler 0x1C Lösungsansatz (CCBM Zähler auf 0 setzen) | FST-2XT Etage 07 sperren und mit Innen-Prio befahren | TFT.210 und TFT.110 Bus-Typen | CBM2 Parametrierung über CAN an FST-2XT
- MISS 6e181022 · Q: FST2+3 geht auf Störung Bremsüberwachung. Die Spannung an der Bremskontakteingängen ändert sich beim fahren nicht.
  missing: Wichtige Informationen zu CBM-2 Unterstromfehler in Ticket TC240471 (65914649), Half-Wave Mode Bremsspannungsprobleme (35f840a1)
  recalled 25: Regler Error 532 is occuring with FST and Ziehl-abbeg frequency inverter in CANopen drive mode | FST-2XT Inspektion FK Display-Reset | Türendschalter JA und fehlender Endschalter-Auf blockiert Türschließung | LSU-Antriebsfehler Testverfahren iValve | FST-2 auf FST-2XT Tausch: Stecker X13 und Brücke 7-14 | Vorendschalter-Prüfung Schachtgruben-Inspektion FST2/3 | Fehlerspeicher Frequenzumrichter prüfen bei LSU-Antriebsfehler | UCM Fehler durch veraltete FST3 Software | LSU-Zwangshalt bei DB-Anlagen durch TDF-Modul | FST2/3 Sporadische Inspektion durch EMV / Motorschirm | FST-2XT Absinkschutz bei Inspektion | FST-2XT Fehler 15 LSU Seilschlupf | Korrektur: CANopen Tür-Initialisierung A+B und Bypass-Verhalten | Bremskontakte Verdrahtung und Hängekabel | Bypass funktioniert nicht - FST-2 / FST-3 Fehlerquellen und Lösungen | Limax2M Geberwert ändert sich nicht - Jumper-Einstellungen | Diagnosehinweis Riegelmagnet und Riegelkurve | FST-2XT / GST-XT Umbau: Selektivruf-Fehlerbehebung bei alten EAZ-Modulen | FST-3 S2 UCM-A3 Test ohne ASS SBR Relais Verhalten | CBM2 Bremsenbetrieb mit 24V | FST-2XT KEIN FEHLER Anzeige-Bedeutung | FSM-2 Jumperstellung bei CAN-Bus Türantrieb (Bypass-Betrieb) | CBM2 Fehler 0x1C Lösungsansatz (CCBM Zähler auf 0 setzen) | FST-2XT DCP03 Stillstanderkennung Schalter-4 bei älteren Umrichtern | Inkrementalgeber Orientierung überblendet Überlast
- MISS 17d8df08 · Q: Als zusätzliche Antwort hinzufügen: Haben eventuell die Vorendschalter geschaltet? Messen an X17/18
  missing: Schachtgruben-Inspektion Reset Morsecode (neuere Methode) (729f8afe)
  recalled 25: Fernabschaltung - Kabinenlichtschalter | Tür öffnet nicht - Endschalter | FST-2XT Zwangsschließen durch Lichtschrankenfehler | Absinkschutz Fehlerdetails | Troubleshooting ADM - External Call Issues | FSM LS/RV Pegel bei alten FSMs | Fahrkorbtür schließt nicht: Motor-ZU/K2 aktiv -> Türsteuergerät | Falsche Verdrahtung des Sicherheitskreises bei FST2XT | Sperrmittel Anzeige und Lichtschranke | FST-2XT Endschaltertest blockiert durch Endhaltestellensperre | FST-2XT Etagen sperren | Türendschalter JA und fehlender Endschalter-Auf blockiert Türschließung | FST-2 auf FST-2XT Tausch: Stecker X13 und Brücke 7-14 | Vorendschalter-Prüfung Schachtgruben-Inspektion FST2/3 | Limax2M Geberwert ändert sich nicht - Jumper-Einstellungen | Schalter S14 bei Fernabschaltung (FST-2XT) | Diagnosehinweis Riegelmagnet und Riegelkurve | Absinkschutz Abfallverzögerung an Schneider-Schützen anpassen | CAN Türantrieb undefinierte Befehle - Endschalter Einstellung | Miscel-4 Bit-0 (00000001): Türen bei Fernabschaltung offenhalten | FST-3 S2 UCM-A3 Test ohne ASS SBR Relais Verhalten | FSM-2 Jumperstellung bei CAN-Bus Türantrieb (Bypass-Betrieb) | Riegelfehler Ursachen (Schachttür / Sperrmittelschalter) | FST-2XT DCP03 Stillstanderkennung Schalter-4 bei älteren Umrichtern | FSM-2 Portbelegung X24
- MISS 3caf700e · Q: Als zusätzliche Antwort hinzufügen: Haben eventuell die Vorendschalter geschaltet? Messen an X17/18
  missing: Schachtgruben-Inspektion Reset Morsecode (neuere Methode) (729f8afe)
  recalled 25: Fernabschaltung - Kabinenlichtschalter | Tür öffnet nicht - Endschalter | FST-2XT Zwangsschließen durch Lichtschrankenfehler | Absinkschutz Fehlerdetails | Troubleshooting ADM - External Call Issues | FSM LS/RV Pegel bei alten FSMs | Fahrkorbtür schließt nicht: Motor-ZU/K2 aktiv -> Türsteuergerät | Falsche Verdrahtung des Sicherheitskreises bei FST2XT | Sperrmittel Anzeige und Lichtschranke | FST-2XT Endschaltertest blockiert durch Endhaltestellensperre | FST-2XT Etagen sperren | Türendschalter JA und fehlender Endschalter-Auf blockiert Türschließung | FST-2 auf FST-2XT Tausch: Stecker X13 und Brücke 7-14 | Vorendschalter-Prüfung Schachtgruben-Inspektion FST2/3 | Limax2M Geberwert ändert sich nicht - Jumper-Einstellungen | Schalter S14 bei Fernabschaltung (FST-2XT) | Diagnosehinweis Riegelmagnet und Riegelkurve | Absinkschutz Abfallverzögerung an Schneider-Schützen anpassen | CAN Türantrieb undefinierte Befehle - Endschalter Einstellung | Miscel-4 Bit-0 (00000001): Türen bei Fernabschaltung offenhalten | FST-3 S2 UCM-A3 Test ohne ASS SBR Relais Verhalten | FSM-2 Jumperstellung bei CAN-Bus Türantrieb (Bypass-Betrieb) | Riegelfehler Ursachen (Schachttür / Sperrmittelschalter) | FST-2XT DCP03 Stillstanderkennung Schalter-4 bei älteren Umrichtern | FSM-2 Portbelegung X24
- MISS 4f9e1821 · Q: was muss man bei der FST-2XT einstellen, damit eine zu lange unterbrochene Lichtschranke eine Fehlermeldung verursacht?
  missing: LS und RS Bedeutung in FST Tür Parametern (edfc9649)
  recalled 25: FST Türparameter Max - Zyklen | FST-2XT Zwangsschließen durch Lichtschrankenfehler | FST-2XT Inspektions-Haltepunkte | Regler Error 532 is occuring with FST and Ziehl-abbeg frequency inverter in CANopen drive mode | FST-2XT Etagen sperren | FST-2XT Inspektion FK Display-Reset | Einfahrgeschwindigkeit Translation FST-2XT | Türendschalter JA und fehlender Endschalter-Auf blockiert Türschließung | FST-2 auf FST-2XT Tausch: Stecker X13 und Brücke 7-14 | Vorendschalter-Prüfung Schachtgruben-Inspektion FST2/3 | FST2/3 Sporadische Inspektion durch EMV / Motorschirm | FST-2XT Absinkschutz bei Inspektion | FST-2XT Fehler 15 LSU Seilschlupf | Bypass funktioniert nicht - FST-2 / FST-3 Fehlerquellen und Lösungen | Limax2M Geberwert ändert sich nicht - Jumper-Einstellungen | Schalter S14 bei Fernabschaltung (FST-2XT) | Diagnosehinweis Riegelmagnet und Riegelkurve | FST-2XT / GST-XT Umbau: Selektivruf-Fehlerbehebung bei alten EAZ-Modulen | Absinkschutz Abfallverzögerung an Schneider-Schützen anpassen | Miscel-4 Bit-0 (00000001): Türen bei Fernabschaltung offenhalten | FST-2XT KEIN FEHLER Anzeige-Bedeutung | FST-2XT Absolutwertkopierung Auflösung berechnen | FST-2XT Etage 07 sperren und mit Innen-Prio befahren | FST-2XT DCP03 Stillstanderkennung Schalter-4 bei älteren Umrichtern | CBM2 Parametrierung über CAN an FST-2XT

## Stage 2 — answer quality vs the verified answers

Mean score: **64.7** over 67 cases (gate ≥ 70: FAIL)
· cited cases below 50: 10 (gate 0: FAIL)

Excluded as "remember this" turns (the new design stops at the save card instead of answering): **5** — 2d27114a, 8827260a, 841aaf8f, 107c7e94, eb1f6a84

Mean by group: cited 64.0 (47 cases) · non-cited 66.5 (20 cases)

| case | cited | hit | score | reason |
| --- | --- | --- | --- | --- |
| c72aaa16 |  | – | 85 | The actual answer correctly provides all key dimensions and the exact positioning distance for tank type 2, but omits the additional detailed hole and notch spacing measurements. |
| 033a78be |  | – | 95 | The actual answer provides the same pinout, connector, low-active switching logic, and menu configuration guidance, with only minor differences in formatting the wiring steps. |
| 032fd42a |  | – | 60 | The actual answer covers the field service troubleshooting tips and port behaviors well, but completely omits the official software integration details for Bucher-ELRV and the specific Bucher iValve Devehissar configuration parameters. |
| 01cdc74e |  | – | 100 | The actual answer preserves all facts, safety warnings, step-by-step instructions for both methods, and troubleshooting codes accurately and completely. |
| e37a11ea |  | – | 100 | The actual answer preserves all the facts, menu paths, reset buttons, and troubleshooting notes from the verified answer, structured clearly in a step-by-step format. |
| 068ce1e1 | C | ✓ | 85 | The actual answer correctly confirms that the MDD6 supports digital inputs and provides extensive technical details and parameters on the MDD6 itself, though it omits the FSM-2 jumper settings mentioned in the verified answer. |
| 5cc14a50 |  | – | 85 | The actual answer covers almost all key technical data, terminal assignments, and the error reset procedure, but omits the detailed list of input and reset wiring variants. |
| 71a025ea |  | – | 85 | The actual answer correctly identifies the CE 0035 marking and explains the notified body for production monitoring, omitting only the additional details about the type examination by Liftinstituut. |
| fd9bc054 |  | – | 20 | The actual answer correctly states that hold-to-run control is possible, but confuses car travel hold-to-run with firefighter door hold-to-run, missing the specific V0188 feature and raw port configuration (000n68F2). |
| 51206e77 |  | – | 100 | The actual answer covers all the facts from the verified answer, correctly identifies the certificate number, and provides helpful additional details on versions and document locations. |
| 79a05a38 |  | – | 85 | The actual answer explains the error and its causes very accurately with great practical details, but omits the specific FST menu path for the reset (TESTMENUE -> S2-Fehler Reset) and the 3-second hold duration for the physical button. |
| d62db1eb |  | – | 95 | The actual answer preserves all the core facts, technical context, and recommended steps from the verified answer, offering two well-formulated draft options instead of three. |
| 1ef3ada3 |  | – | 90 | The actual answer focuses strictly on ESM-related bugfixes and features across software versions, providing comprehensive details and clear categorization. |
| ddcceafe |  | – | 0 | The actual answer completely misses the topic of temperature monitoring (TDF module) action codes and instead incorrectly explains door runtime monitoring (LSU door errors) and general event codes. |
| 1924fa38 |  | – | 25 | The actual answer incorrectly states that downloading recordings directly via the Elevision web interface is not possible, completely missing the standard manual procedure and the playback/evaluation instructions. |
| c55553b1 |  | – | 45 | The actual answer misses the essential TFT-45 display configuration (floor assignment, FST-ID, door side) and the specific FST Gong menu settings, replacing them instead with firmware update procedures. |
| b434a719 |  | – | 0 | The actual answer directly contradicts the verified answer by stating that 'Freigabe' alone is not sufficient and that a GND connection is mandatory for buttons to function. |
| 887b879b |  | – | 85 | The actual answer correctly answers the question with technical reasons and terminal connections, but omits the alternative option of connecting the brake coils in series. |
| 18298553 | C | ✓ | 85 | The actual answer provides the correct meaning, menu path, and the 1.0 s debounce recommendation, but omits the inversion to 000048F3 (NC) and the note regarding older software versions. |
| 47baf6e8 | C | ✓ | 85 | The actual answer covers the port meaning, correct menu path, and the practical 1.0s debounce recommendation, but introduces slight confusion regarding NO/NC (F2 vs F3) and omits the inversion and software-version notes. |
| df65b2d6 |  | – | 85 | The actual answer correctly identifies the IP54 rating and its definition regarding water and dust protection, but omits the humidity specification and the contextual comparison to floor sensors. |
| 053e7d79 |  | – | 90 | The actual answer gives the correct time (20 seconds, not 2 minutes) and cites the EN 81-73 standard with helpful additional context, but omits the specific clause number and the VDI 6017 reference. |
| 7220c9e3 |  | – | 0 | The actual answer directly contradicts the verified answer by stating that this can be configured, which is factually incorrect and violates safety standards. |
| 18c8ac50 | C | ✓ | 70 | The actual answer explains the menu settings accurately, but completely omits the essential hardware requirement (LCG-02 gateway module) for connecting CANopen to the FST-2XT. |
| 17b55f0a | C | ✓ | 90 | The actual answer correctly identifies the code, cause, and solution with switch S14, and provides a helpful byte breakdown, only omitting the key shortcut to open the SRC menu. |
| 34daba73 | C | ✓ | 50 | The actual answer misidentifies the status letter in the real-time diagnostic line as 'Z' instead of 'K' for the car emergency stop, omits the error log diagnosis, and describes different UI indicators. |
| 9e67e276 | C | ✓ | 100 | The actual answer preserves all the facts, menu paths, and troubleshooting steps from the verified answer while providing useful additional context. |
| 2e313733 | C | ✓ | 75 | The actual answer accurately details the jumper settings and adds a direct connection test, but completely omits the critical troubleshooting steps regarding EMC interference and shielding. |
| 66da87bb | C | ✓ | 70 | Die Angaben zu CBM2 stimmen exakt überein, jedoch fehlen die Hardwarestände für CBM1 sowie die Erwähnung der CBM3-Generation gänzlich. |
| be02d628 | C | ✓ | 100 | The actual answer preserves all technical details, normative reasons, connector and wiring specifics (X13, bridge 7-14), and recommended solution options. |
| 21d1b71a | C | ✓ | 80 | The actual answer gives clear, accurate, step-by-step guidance for executing the safety gear test via the dedicated menu functions (FangTest-Automatik and FangTest-Sofort) and resetting it, but omits the 125% overspeed limiter test and the wire jumper check detailed in the verified answer. |
| 03af8a7d | C | ✓ | 50 | The actual answer provides good configuration parameters and FSM jumper settings, but misses the single most critical point: the completely different CAN pinout between Langer & Laumann and Meiller connectors, as well as the MDD6 learn run. |
| 4c5da8f9 | C | ✗ | 75 | The actual answer covers the main parameters, physical conditions, and software bugs well, but omits the FST-3/S2 teaching procedure and specific hardware wiring checks. |
| c0978411 | C | ✓ | 45 | The actual answer misses the Morse code method via the landing call button and the FST menu reset procedure entirely, focusing instead on relay K205 troubleshooting and hardware bypasses. |
| 6e680483 | C | ✗ | 85 | The actual answer covers the main troubleshooting steps (LON search, LEDs, 250 mA fuse, Außensteuerung disabled, termination) and provides great display diagnostics, but omits the Tableautest and the detailed ADM pinout measurements. |
| e0ff22cf | C | ✓ | 88 | The actual answer covers almost all the core technical points, specific terminals (X1.19, X1.20, X1.21), and exact parameter timing adjustments, omitting only a few diagnostic steps like disabling drive monitoring and the distinction between LSU error types. |
| e901cdd9 | C | ✓ | 100 | The actual answer preserves all the facts, menu paths, terminal numbers, and troubleshooting steps from the verified answer perfectly. |
| 35ac434e | C | ✓ | 0 | The actual answer is completely empty and provides no information. |
| f71afc87 | C | ✗ | 50 | While the activation path and short shaft calibration parameter are preserved, the actual answer omits the entire EN 81-20 and UCM-A3 submenus as well as most specific settings and Miscel bits from the verified answer, replacing them with different registers. |
| 8be51b0b | C | ✗ | 25 | The actual answer fails to include the essential bit configurations (Miscel-15 Bit-0, Miscel-22.6) and specific menu parameters described in the verified answer, offering different and largely inaccurate settings instead. |
| fb95867a | C | ✓ | 60 | The actual answer covers most core standard menu parameters, but misses key items like the Phase-1 and Phase-2 door settings and Feuerwehr Reset, misinterprets 'Aus nur HHS' as starting rather than switching off the mode, and omits the newer software options. |
| 6cbae212 | C | ✓ | 55 | The actual answer correctly identifies the menu path and bits 1 and 7, but completely omits bits 2, 3, and 4 which are detailed in the verified answer. |
| 91165dc5 | C | ✓ | 65 | The actual answer correctly identifies the Startverzögerung parameter and checking the K60 relay, but misses the crucial advice to disable brake monitoring in the inverter, adjust Bremswartezeit, and correctly allocate the brake monitoring paths (Bremsüberwachung 1/2). |
| 2d27114a | C | ✓ | skipped | excluded: remember-this turn |
| c2261d86 | C | ✓ | 95 | The actual answer correctly covers all key troubleshooting steps, parameters, jumper settings, and terminals from the verified answer, with only minor details omitted and a helpful extra check included. |
| 9a35d1ac | C | ✓ | 45 | The actual answer shares the basic MDD6 Node-IDs, baud rate, and termination checks, but completely misses the core focus of the verified answer regarding the LCG-01 gateway, firmware versions (V23/V30), and display wiring differences (Molex pinout). |
| 1e336fef | C | ✓ | 85 | The actual answer covers all major solutions from the verified answer (Node-IDs, V194 bug and workaround, limit switch parameter), but misses the door learn run and FPM module check while adding helpful hardware details. |
| 8827260a | C | ✓ | skipped | excluded: remember-this turn |
| 841aaf8f | C | ✓ | skipped | excluded: remember-this turn |
| db61e5f4 | C | ✓ | 95 | The actual answer confirms the correct software versions and their application with the CUS-CQ module, only omitting the minor detail about the N6050 processor. |
| 29704bd0 | C | ✓ | 85 | The actual answer covers almost all key points, menu paths, and terminal designations, but omits the specific check and bypass regarding the unintended car movement/brake feedback (ABS/SBR). |
| 3149e024 | C | ✗ | 80 | The actual answer covers key points like encoder shielding (J120 at X12, 0.3 Ohm), mechanical blockage at additional door locks, and door open delay, but omits FSM/FPM hardware checks, specific parameters (K210.1, K212), and the recording diagnostics while adding other plausible causes. |
| 1fd2a79b | C | ✓ | 85 | The actual answer explains the physical cause and provides the correct FST-3 software fix (V0194E) and ASV checks, but omits specific FST menu navigation paths for ASV and releveling settings. |
| a5af5f43 | C | ✗ | 65 | The answer correctly covers the hardware bridge on X1.4/X1.5 and the DRIVE/BRAKE signal sequence, but completely misses the known voltage configuration bug (0x0C / unrounded voltages) and EMC/bus troubleshooting, offering LED diagnostics and error 0x1C instead. |
| 62449928 | C | ✓ | 0 | The actual answer is completely empty and provides none of the guidance or information from the verified answer. |
| f23494f5 | C | ✓ | 90 | The actual answer covers all the key facts and troubleshooting steps (X13 connector, jumper 7-14, X13.12/S28, and relay K59.7 reset), but inverts the order of priority and omits the specific fuse designation (F4) for the power cycle. |
| 44b361f5 | C | ✓ | 0 | The actual answer is completely empty, missing all technical guidance and facts. |
| c41334b9 | C | ✓ | 0 | The actual answer is completely empty and provides no information. |
| 6e181022 | C | ✗ | 55 | While the actual answer offers some useful hardware and CBM-2 checks, it completely omits the standard FST menu configuration parameters (HAUPTMENUE / Antrieb / Bremsueberwachung: Invertiert, Bremswartezeit) and the diagnostic test of bridging the inputs. |
| 17d8df08 | C | ✗ | 0 | The actual answer is completely empty and fails to provide any of the requested guidance. |
| 3caf700e | C | ✗ | 0 | The actual answer is completely empty and fails to provide any of the guidance or information from the verified answer. |
| 107c7e94 | C | ✓ | skipped | excluded: remember-this turn |
| eb1f6a84 | C | ✓ | skipped | excluded: remember-this turn |
| 601efa06 | C | ✓ | 0 | The actual answer misses the correct combined RAW value (001A029A) and instead invents completely different, separate hex functions across two ports. |
| 90f9d60a | C | ✓ | 85 | The actual answer covers the software version fixes and exact menu paths accurately, but omits the hardware and EMC/LIMAX sensor checks mentioned in the verified answer while adding extra details on the S2 software. |
| 42b07a5b | C | ✓ | 90 | The answer provides all the key technical terms and abbreviations (COP, LOP) correctly, only omitting the general term for the cabin itself (Car/Cabin). |
| 67af1253 | C | ✓ | 80 | The actual answer covers the main causes, menu paths, and display diagnostics well, but omits the NO/NC logic parameter check and provides differing terminal designations. |
| 45ccba17 | C | ✓ | 50 | While the actual answer covers CAN bus termination and node IDs, it completely misses the major guidance regarding the CBM-2 brake module issues and microswitch monitoring. |
| ea7ec983 | C | ✓ | 85 | The actual answer covers the main causes and precise menu paths accurately, but omits the check for zone and correction switches (KO/KU) while adding other plausible causes. |
| 4f9e1821 | C | ✗ | 50 | The actual answer correctly mentions the door reversal parameters, but omits the specific menu path to find them, misses the key parameter 'Tür Block Max', and leaves out crucial details such as value 0 disabling the monitoring. |
| 9e1343de | C | ✓ | 100 | The actual answer provides the exact same information, version number, date, and reference as the verified answer, with helpful minor elaboration on the component name. |
| bbb44ef4 | C | ✓ | 100 | The actual answer preserves all the facts and guidance from the verified answer while providing accurate menu paths and helpful additional context. |

### Errors

- 1a0356cd: 500 fetch failed

## Decision

NO-GO — Stage 1 PASS (80.8 % ≥ 80 %), Stage 2 FAIL (mean 64.7 ≥ 70, 10 cited case(s) below 50).
---

## Addendum (controller analysis of `out/judged-rerun.json`)

**Stage 1 passes** (42/52 cited cases, 80.8 %; per item 62/76). Compared with the first run this is the
conversation-aware recall query at limit 25 against a four-times larger cited population.

**Stage 2 fails as produced, but six of the ten failing cited cases are empty answers whose turn ended at a
pending `tool-Remember` approval card** — verified in `agent_messages` for all six sessions (parts:
`text:done, tool-Context_Search:output-available, tool-Remember:approval-requested`). Their questions are
teach-the-agent turns the exclusion regex did not match: "Merke noch zusätzlich beim Fehler S2-Traktion …" (×2),
"Als zusätzliche Antwort hinzufügen: …" (×2), "Bitte Antwort 3.,4.,5. bei dieser Frage nicht mehr bringen",
"Die DCP Verbindung scheint nicht in Ordnung zu sein …". The new design correctly stops there instead of answering.

Excluding every approval-paused turn (5 by regex + 6 observed = 11):

| Measure | Value |
| --- | --- |
| Scorable cases | 61 |
| Mean (gate ≥ 70) | **71.1** |
| Cited scorable / mean | 41 / 73.4 |
| Non-cited scorable / mean | 20 / 66.5 |
| Cited below 50 (gate 0) | **4** (9.8 % of cited scorable) |
| Cited below 60 / at or above 80 | 11 / 23 |
| Paired with the first run (31 non-paused cases, limit 10 → 25 + Task 6b) | 70.1 → 72.3 |
| Cited cases: recall hit vs miss, judge mean | 76.5 (n 33) vs 60.6 (n 8) |

The four cited cases below 50:

| Case | Score | Recall | Question | Judge reason (short) |
| --- | --- | --- | --- | --- |
| 601efa06 | 0 | hit | "Bitte nochmal überlegen: Etage 02 und Geschwindigkeit …" | wrong combined RAW value (001A029A) invented |
| 8be51b0b | 25 | miss | "Brandfall vom ADM/EAZ soll beide Tür Seiten öffnen bei einer FST-2XT" | missing Miscel-15 Bit-0 / Miscel-22.6 configuration (the memory was not recalled) |
| c0978411 | 45 | hit | "Wie kann man die Notentriegelung reseten" | omits the Morse-code method and the FST menu reset |
| 9a35d1ac | 45 | hit | "was kann der Grund sein, wenn bei einem MDD6 Can der Türstand …" | basics right, misses the specific cause |

**Decision under the gates as written: NO-GO** (Stage 2 sub-gate "no cited case below 50"). Under the mean gate
alone it passes once approval-paused turns are excluded correctly. The recall change is effective: recalled
memories lift the judge mean by about 16 points on cited cases, and the paired comparison improves.

Recommendations for Daniel's call: (1) make the "approval-paused" exclusion observation-based (the turn ended at
a memory approval card) instead of a question regex; (2) replace the zero-tolerance sub-gate with "≤ 10 % of
cited scorable cases below 50" or review the four cases above individually (one is a hallucinated RAW value,
one a recall miss, two partial answers); (3) keep Newton's limit at 25.

Housekeeping: 177 `[memory-eval]` sessions in `exulu-test` (user 51); `temporary_eval_key` still active
(super-admin) — revoke.
