# WWE Project Board

Ein Obsidian-Plugin, das eine Bases-View als Kanban-Board für Projekte bereitstellt
und die Projekt- und Kundendateien zu einer Deckblatt-Ansicht aufräumt.

## Was das Plugin macht

**Board-View** (`wwe-project-board`) — registriert über `registerBasesView`. Zeigt die
von der Base gefilterten Dateien als Karten, gruppiert nach der Frontmatter-Eigenschaft
`fortschritt`. Spalten und Karten lassen sich per Drag and Drop umsortieren, Karten
zwischen Spalten zu ziehen schreibt den neuen Status ins Frontmatter. Darüber sitzt eine
Leiste mit Volltextfilter über alle Frontmatter-Eigenschaften und einem Zoom.

**Deckblatt-Ansicht** — jede `_index.md` mit `typ: projekt` wird beim Öffnen aufgeräumt:
Obsidians Dateiname und Eigenschaftenblock verschwinden, stattdessen gibt es eine eigene
Kopfzeile mit Kunden-Chip und Projektnamen sowie ein einklappbares Panel links zum
Bearbeiten der Eigenschaften. Der Markdown-Editor selbst bleibt Obsidians eigener.

**Kundenseite** — jede `_index.md` mit `typ: kunde` bekommt dieselbe Behandlung, dazu
rechts eine Liste der Projekte dieses Kunden als Karten.

## Erwartete Vault-Struktur

```
<Kundenwurzel>/           z.B. "Kunden"
  <Kundenname>/
    _index.md             typ: kunde
    <Projektname>/
      _index.md           typ: projekt
```

Ordnernamen und die Eigenschaften `projekt` und `kunde` sollen übereinstimmen. Weichen
sie ab, zeigt die Karte ein Warndreieck. Im Eigenschaften-Panel stehen beide Felder
deshalb hinter einem Schloss. Der Kundenwurzelordner ist nirgends fest verdrahtet — er
wird aus den Daten erschlossen.

## Entwicklung

```bash
npm install
npm run dev     # baut bei jeder Dateiänderung
npm run build   # einmaliger Produktionsbuild
```

Das Plugin ist in die Test-Vault symlinked:

```
Test Vault for Project Board Obsidian Plugin/.obsidian/plugins/wwe-project-board
  -> WWE Project Board Obsidian Plugin/
```

`main.js` und `node_modules/` sind bewusst nicht im Repo — der Build erzeugt sie.

## Neuladen in Obsidian: die Fallstricke

Das hat schon einmal viel Zeit gekostet, deshalb hier ausgeschrieben.

**Obsidians „Anwendung neu laden ohne zu speichern" lädt nur `main.js` neu, nicht
`styles.css`.** CSS-Änderungen kommen darüber nie an. Umgekehrt lädt das Aus- und
Einschalten des Plugins in den Einstellungen die `styles.css` neu, aber nicht zwingend
das frisch gebaute JavaScript. Wer beides von Hand macht, braucht also beides.

**Deshalb ist das Hot-Reload-Plugin von pjeby installiert.** Es überwacht `main.js` und
`styles.css` jedes Plugin-Ordners mit `.git`-Unterverzeichnis oder `.hotreload`-Datei —
unser Ordner ist ein Git-Repo, also ohne Konfiguration — und schaltet das Plugin bei
Änderungen komplett aus und wieder ein. Damit reicht ein Build.

**Eine bereits offene Bases-View bleibt trotzdem die alte Instanz.** Die Board-Ansicht
gehört Obsidians Bases-Plugin, nicht unserem. Ein Plugin-Reload registriert den View-Typ
neu, tauscht die laufende View aber nicht aus. Nach einer Änderung am Board also einmal
auf eine andere Datei und zurück auf die Base klicken. Deckblatt- und Kundenseiten sind
davon nicht betroffen, die werden beim nächsten `file-open` ohnehin neu dekoriert.

**Die Meldung „Hot Reload: styles.css not found" in der Konsole ist harmlos.** Hot Reload
findet die Datei über den Symlink nicht, das Aus- und Einschalten lädt die CSS aber
ohnehin frisch von der Platte.

## Wo der Zustand liegt

Bewusst getrennt, weil das eine geteilt gehört und das andere nicht:

| Zustand | Ort | Warum |
| --- | --- | --- |
| Spaltenreihenfolge, Kartenreihenfolge, `boardId` | View-Konfiguration in der `.base`-Datei | gehört zur Base und darf mitwandern |
| Eingeklappte Spalten, Zoom, Panel- und Dateikopf-Schalter | `app.saveLocalStorage` | gehört dem Gerät und wird nie mitsynchronisiert |
| Zuletzt angeklickte Karte | Plugin-Instanz, nur zur Laufzeit | überlebt das Wegnavigieren, aber keinen Neustart |

Da die Base-Datei den Pfad nicht über die API preisgibt, bekommt jede View beim ersten
Speichern eine eigene `boardId` in die `.base`-Datei geschrieben. Die dient als Schlüssel
für den geräte-lokalen Zustand.

## Bekannte Grenzen

- In der Tab-Leiste steht weiterhin `_index`. Den Tab-Titel kann ein Plugin nicht ändern,
  ohne Obsidian-Interna zu patchen.
- Es gibt keinen wiederverwendbaren Markdown-Editor in der API: `MarkdownEditView`
  verlangt im Konstruktor eine komplette `MarkdownView`. Deshalb bleibt Obsidians Editor
  stehen und nur das Drumherum wird ausgeblendet.
- Der eingebaute „Neu"-Button von Bases lässt sich nicht überschreiben —
  `BasesViewRegistration` bietet keinen Haken dafür. Deshalb das eigene Plus je Spalte.
- Ändert man Eigenschaften außerhalb, während das Panel offen ist, zeigt es bis zum
  nächsten Öffnen noch die alten Werte.
