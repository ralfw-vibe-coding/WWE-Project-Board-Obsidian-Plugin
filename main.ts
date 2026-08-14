import {
	App,
	BasesEntry,
	BasesPropertyId,
	BasesView,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	QueryController,
	TFile,
	TFolder,
	debounce,
	setIcon,
} from "obsidian";
import Sortable from "sortablejs";

const VIEW_TYPE = "wwe-project-board";
const RENDER_DELAY = 120;

const P = {
	PROJEKT: "note.projekt" as BasesPropertyId,
	KUNDE: "note.kunde" as BasesPropertyId,
	FORTSCHRITT: "note.fortschritt" as BasesPropertyId,
	ANSPRECHPARTNER: "note.ansprechpartner" as BasesPropertyId,
	FORMAT: "note.format" as BasesPropertyId,
	OWNER: "note.owner" as BasesPropertyId,
	WIEDERVORLAGE: "note.wiedervorlage" as BasesPropertyId,
	DEADLINE: "note.deadline" as BasesPropertyId,
	TAGS: "note.tags" as BasesPropertyId,
};

const NO_STATUS = "Ohne Status";

/** Mehr Treffer werden nicht gezeigt — man tippt weiter, statt zu scrollen. */
const MAX_VISIBLE_CUSTOMERS = 6;

/**
 * Eingeklappte Spalten und Zoom gehören dem Gerät, nicht der Base: sie landen
 * im localStorage der Vault und werden nie mitsynchronisiert.
 */
const LOCAL_STATE_PREFIX = "wwe-project-board:";

/** Deckblatt-Ansicht: Dateikopf ausblenden, eigene Kopfzeile und Panel einsetzen. */
const COVER_CLASS = "wwe-cover";
const COVER_CHROME_CLASS = "wwe-cover-chrome";
const COVER_PANEL_OPEN_CLASS = "wwe-cover-panel-open";
const COVER_HEADER_CLASS = "wwe-cover-header";
const COVER_PANEL_CLASS = "wwe-cover-panel";
const COVER_PROJECTS_CLASS = "wwe-cover-projects";
const SHOW_CHROME_KEY = "wwe-project-board:show-file-chrome";
const SHOW_PANEL_KEY = "wwe-project-board:show-cover-panel";

type CoverFieldKind = "text" | "date" | "list" | "select";

interface CoverField {
	key: string;
	label: string;
	kind: CoverFieldKind;
	/** Hinter Schloss: ändert man diese Werte, laufen sie den Ordnernamen davon. */
	locked?: boolean;
}

/** "typ" fehlt bewusst: der ist strukturell und darf nicht aus Versehen kippen. */
const COVER_FIELDS: CoverField[] = [
	{ key: "projekt", label: "Projekt", kind: "text", locked: true },
	{ key: "kunde", label: "Kunde", kind: "text", locked: true },
	{ key: "fortschritt", label: "Fortschritt", kind: "select" },
	{ key: "owner", label: "Owner", kind: "list" },
	{ key: "ansprechpartner", label: "Ansprechpartner", kind: "text" },
	{ key: "format", label: "Format", kind: "text" },
	{ key: "wiedervorlage", label: "Wiedervorlage", kind: "date" },
	{ key: "deadline", label: "Deadline", kind: "date" },
	{ key: "created", label: "Angelegt", kind: "date" },
	{ key: "author", label: "Angelegt von", kind: "list" },
	{ key: "tags", label: "Tags", kind: "list" },
];

const ZOOM_MIN = 50;
const ZOOM_MAX = 130;
const ZOOM_STEP = 10;
const ZOOM_DEFAULT = 100;

const DEFAULT_STATUS_ORDER = [
	"Konzeption",
	"Angeboten",
	"Angenommen",
	"in Vorbereitung",
	"in Durchführung",
	"Erledigt",
	"Nicht zustande gekommen",
];

const STATUS_HUE: Record<string, string> = {
	"Konzeption": "#888780",
	"Angeboten": "#EF9F27",
	"Angenommen": "#378ADD",
	"in Vorbereitung": "#7F77DD",
	"in Durchführung": "#1D9E75",
	"Erledigt": "#639922",
	"Nicht zustande gekommen": "#E24B4A",
};

const PALETTE = [
	"#7F77DD",
	"#1D9E75",
	"#D85A30",
	"#D4537E",
	"#378ADD",
	"#639922",
	"#BA7517",
	"#0E9AA7",
];

function hueFor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	}
	return PALETTE[hash % PALETTE.length];
}

/**
 * Obsidians Auswertung wirft bei unsauberem Frontmatter — etwa einer Liste mit
 * leerem Eintrag oder einem Datumsfeld, in dem ein Name steht. Ohne Auffangen
 * riss ein einziger solcher Eintrag den ganzen Render mit, sodass die Hälfte
 * der Karten fehlte und das Board gar nicht mehr bedienbar war.
 */
function text(entry: BasesEntry, prop: BasesPropertyId): string {
	try {
		const value = entry.getValue(prop);
		if (!value || !value.isTruthy()) return "";
		return value.toString().trim();
	} catch (error) {
		console.warn(
			`WWE Project Board: "${prop}" in ${entry.file.path} ist nicht lesbar.`,
			error
		);
		return "";
	}
}

function list(entry: BasesEntry, prop: BasesPropertyId): string[] {
	const raw = text(entry, prop);
	if (!raw) return [];
	return raw
		.split(/\s*,\s*/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function initials(name: string): string {
	const parts = name.split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatDate(raw: string): string {
	const match = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
	if (!match) return raw;
	return `${match[3]}.${match[2]}.${match[1].slice(2)}`;
}

/** Kleinschreibung ohne Akzente, damit "Mu" auch "Müller" findet. */
function foldText(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/ß/g, "ss")
		.toLowerCase();
}

function today(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

/** Frontmatter für ein neues Projekt — Feldreihenfolge wie in den bestehenden Deckblättern. */
function newProjectNote(projekt: string, kunde: string, status: string): string {
	return [
		"---",
		`projekt: "${projekt.replace(/"/g, '\\"')}"`,
		"typ: projekt",
		`kunde: "${kunde.replace(/"/g, '\\"')}"`,
		"owner: []",
		`created: ${today()}`,
		`fortschritt: ${status === NO_STATUS ? "" : status}`,
		"ansprechpartner: ",
		"format: ",
		"wiedervorlage: ",
		"deadline: ",
		"author: []",
		"tags: []",
		"---",
		"",
	].join("\n");
}

function fmText(value: unknown): string {
	if (value === null || value === undefined) return "";
	return String(value).trim();
}

function fmList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => String(item).trim()).filter(Boolean);
	}
	const raw = fmText(value);
	return raw ? raw.split(/\s*,\s*/).filter(Boolean) : [];
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function orderMap(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string[]> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		out[key] = stringArray(raw);
	}
	return out;
}

/** Alles, was eine Projektkarte zeigt — egal ob sie aus einer Base oder aus einer Datei kommt. */
interface CardModel {
	path: string;
	projekt: string;
	/** Auf dem Board der Kunde, auf der Kundenseite der Fortschritt. */
	chip: string;
	chipHue: string;
	drift: string[];
	owners: string[];
	ansprechpartner: string;
	format: string;
	tags: string[];
	wiedervorlage: string;
	deadline: string;
}

function driftOf(
	projekt: string,
	projektFolder: string,
	kunde: string,
	kundeFolder: string
): string[] {
	const drift: string[] = [];
	if (projektFolder && projekt !== projektFolder) {
		drift.push(`Projektordner heißt "${projektFolder}"`);
	}
	if (kundeFolder && kunde !== kundeFolder) {
		drift.push(`Kundenordner heißt "${kundeFolder}"`);
	}
	return drift;
}

function renderMetaRow(parentEl: HTMLElement, icon: string, value: string): void {
	if (!value) return;
	const rowEl = parentEl.createDiv({ cls: "wwe-meta-row" });
	setIcon(rowEl.createSpan({ cls: "wwe-meta-icon" }), icon);
	rowEl.createSpan({ text: value });
}

function renderBadge(
	parentEl: HTMLElement,
	cls: string,
	icon: string,
	label: string,
	raw: string
): void {
	const badgeEl = parentEl.createSpan({ cls: `wwe-badge ${cls}` });
	badgeEl.setAttribute("aria-label", `${label} ${formatDate(raw)}`);
	setIcon(badgeEl.createSpan({ cls: "wwe-badge-icon" }), icon);
	badgeEl.createSpan({ text: formatDate(raw) });
}

/**
 * Der Kundenordner ist der Elternordner des Projektordners. Den nehmen wir
 * statt einer Suche über den Namen — der Ordner ist die Wahrheit, der Name im
 * Frontmatter kann davon abgewichen sein.
 */
function customerIndexOf(file: TFile): TFile | null {
	const index = file.parent?.parent?.children.find(
		(candidate): candidate is TFile =>
			candidate instanceof TFile && candidate.name === "_index.md"
	);
	return index ?? null;
}

function renderProjectCard(
	parentEl: HTMLElement,
	card: CardModel,
	onOpen: () => void,
	onChip?: () => void
): HTMLElement {
	const cardEl = parentEl.createDiv({ cls: "wwe-card" });
	cardEl.setAttribute("data-path", card.path);

	const headEl = cardEl.createDiv({ cls: "wwe-card-head" });
	if (card.chip) {
		const chipEl = headEl.createSpan({ cls: "wwe-chip", text: card.chip });
		chipEl.style.setProperty("--wwe-hue", card.chipHue);
		if (onChip) {
			chipEl.addClass("is-link");
			chipEl.setAttribute("aria-label", `Zur Seite von ${card.chip}`);
			chipEl.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				onChip();
			});
		}
	}
	if (card.drift.length > 0) {
		const warnEl = headEl.createSpan({ cls: "wwe-warn" });
		setIcon(warnEl, "alert-triangle");
		warnEl.setAttribute("aria-label", card.drift.join(" · "));
	}
	if (card.owners.length > 0) {
		const avatarsEl = headEl.createDiv({ cls: "wwe-avatars" });
		for (const owner of card.owners) {
			const avatarEl = avatarsEl.createSpan({ cls: "wwe-avatar", text: initials(owner) });
			avatarEl.style.setProperty("--wwe-hue", hueFor(owner));
			avatarEl.setAttribute("aria-label", owner);
		}
	}

	const titleEl = cardEl.createDiv({ cls: "wwe-card-title", text: card.projekt });
	titleEl.addEventListener("click", (evt) => {
		evt.preventDefault();
		evt.stopPropagation();
		onOpen();
	});

	const metaEl = cardEl.createDiv({ cls: "wwe-meta" });
	renderMetaRow(metaEl, "user", card.ansprechpartner);
	renderMetaRow(metaEl, "presentation", card.format);
	if (metaEl.childElementCount === 0) metaEl.remove();

	if (card.tags.length > 0) {
		const tagsEl = cardEl.createDiv({ cls: "wwe-tags" });
		for (const tag of card.tags) {
			tagsEl.createSpan({ cls: "wwe-tag", text: tag.replace(/^#/, "") });
		}
	}

	if (card.wiedervorlage || card.deadline) {
		const footEl = cardEl.createDiv({ cls: "wwe-card-foot" });
		if (card.wiedervorlage) {
			renderBadge(footEl, "wwe-badge-wv", "clock", "Wiedervorlage", card.wiedervorlage);
		}
		if (card.deadline) {
			renderBadge(footEl, "wwe-badge-dl", "flag", "Deadline", card.deadline);
		}
	}

	return cardEl;
}

class ProjectBoardView extends BasesView {
	type = VIEW_TYPE;
	boardEl: HTMLElement;
	plugin: WweProjectBoardPlugin;

	private rootEl: HTMLElement;
	private toolbarEl: HTMLElement;
	private filterInput!: HTMLInputElement;
	private searchEl!: HTMLElement;
	private countEl!: HTMLElement;
	private zoomLabelEl!: HTMLElement;

	private sortables: Sortable[] = [];
	private prefsLoaded = false;
	private columnOrderPref: string[] = [];
	private cardOrderPref: Record<string, string[]> = {};

	private filterQuery = "";
	private collapsed = new Set<string>();
	private zoom = ZOOM_DEFAULT;

	/**
	 * Während eines Drags nicht neu rendern — sonst reißt Sortable die
	 * Live-Vorschau unter dem Cursor weg.
	 */
	private dragging = false;

	/**
	 * Die View wird beim Zurücknavigieren von der Projektdatei neu gebaut und
	 * startet dabei ganz links. Einmalig zur ausgewählten Karte scrollen, damit
	 * sie sichtbar ist — danach nie wieder, sonst reißt es einen beim Arbeiten
	 * bei jedem Datenupdate aus der Position.
	 */
	private restoreScrollPending = true;

	private scheduleRender: () => void;

	constructor(
		controller: QueryController,
		containerEl: HTMLElement,
		plugin: WweProjectBoardPlugin
	) {
		super(controller);
		this.plugin = plugin;

		this.rootEl = containerEl.createDiv({ cls: "wwe-root" });
		this.toolbarEl = this.rootEl.createDiv({ cls: "wwe-toolbar" });
		this.boardEl = this.rootEl.createDiv({ cls: "wwe-board" });
		// Die Leiste wird einmalig gebaut: ein Neuaufbau bei jedem Render würde
		// beim Tippen den Fokus aus dem Filterfeld reißen.
		this.buildToolbar();

		this.boardEl.addEventListener("click", (evt) => {
			const target = evt.target;
			if (target instanceof HTMLElement && target.closest(".wwe-card-title")) {
				return;
			}
			this.select(null);
		});

		this.scheduleRender = debounce(() => this.render(), RENDER_DELAY);
	}

	onDataUpdated(): void {
		this.scheduleRender();
	}

	onunload(): void {
		this.destroySortables();
	}

	// --- Leiste über den Spalten ------------------------------------------

	private buildToolbar(): void {
		this.searchEl = this.toolbarEl.createDiv({ cls: "wwe-search" });
		setIcon(this.searchEl.createSpan({ cls: "wwe-search-icon" }), "search");
		this.filterInput = this.searchEl.createEl("input", {
			cls: "wwe-search-input",
			attr: { type: "text", placeholder: "In allen Eigenschaften filtern" },
		});
		const clearEl = this.searchEl.createSpan({ cls: "wwe-search-clear" });
		setIcon(clearEl, "x");
		clearEl.setAttribute("aria-label", "Filter zurücksetzen");
		clearEl.addEventListener("click", () => this.clearFilter());

		this.filterInput.addEventListener("input", () => {
			this.filterQuery = this.filterInput.value;
			this.searchEl.toggleClass("has-query", this.filterQuery.length > 0);
			this.saveLocalState();
			this.scheduleRender();
		});
		this.filterInput.addEventListener("keydown", (evt) => {
			if (evt.key !== "Escape" || !this.filterQuery) return;
			// Ohne stopPropagation würde Obsidian den Fokus aus der View nehmen.
			evt.preventDefault();
			evt.stopPropagation();
			this.clearFilter();
		});

		this.countEl = this.toolbarEl.createSpan({ cls: "wwe-toolbar-count" });

		const zoomEl = this.toolbarEl.createDiv({ cls: "wwe-zoom" });
		const outEl = zoomEl.createSpan({ cls: "wwe-zoom-btn" });
		setIcon(outEl, "minus");
		outEl.setAttribute("aria-label", "Kleiner");
		outEl.addEventListener("click", () => this.setZoom(this.zoom - ZOOM_STEP));

		this.zoomLabelEl = zoomEl.createSpan({ cls: "wwe-zoom-label" });

		const inEl = zoomEl.createSpan({ cls: "wwe-zoom-btn" });
		setIcon(inEl, "plus");
		inEl.setAttribute("aria-label", "Größer");
		inEl.addEventListener("click", () => this.setZoom(this.zoom + ZOOM_STEP));

		this.applyZoom();
	}

	private clearFilter(): void {
		this.filterQuery = "";
		this.filterInput.value = "";
		this.searchEl.removeClass("has-query");
		this.saveLocalState();
		this.render();
		this.filterInput.focus();
	}

	/** Sucht über alle Frontmatter-Eigenschaften plus die beiden Ordnernamen. */
	private matchesFilter(entry: BasesEntry): boolean {
		const query = foldText(this.filterQuery.trim());
		if (!query) return true;

		const parts: string[] = [];
		for (const prop of this.allProperties ?? []) {
			if (!prop.startsWith("note.")) continue;
			parts.push(text(entry, prop));
		}
		parts.push(entry.file.parent?.name ?? "");
		parts.push(entry.file.parent?.parent?.name ?? "");

		return foldText(parts.join(" ")).includes(query);
	}

	private updateCount(shown: number, total: number): void {
		this.countEl.setText(shown === total ? "" : `${shown} von ${total}`);
	}

	private setZoom(value: number): void {
		const stepped = Math.round(value / ZOOM_STEP) * ZOOM_STEP;
		const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepped));
		if (next === this.zoom) return;
		this.zoom = next;
		this.applyZoom();
		this.saveLocalState();
	}

	private applyZoom(): void {
		this.boardEl.style.setProperty("zoom", String(this.zoom / 100));
		this.zoomLabelEl.setText(`${this.zoom}%`);
	}

	// --- Persistenz -------------------------------------------------------

	private loadPrefs(): void {
		if (this.prefsLoaded) return;
		this.columnOrderPref = stringArray(this.config?.get("columnOrder"));
		this.cardOrderPref = orderMap(this.config?.get("cardOrder"));
		this.loadLocalState();
		this.prefsLoaded = true;
	}

	/**
	 * Die Base-Datei ist über die API nicht zu erfragen, für den localStorage
	 * braucht es aber einen stabilen Schlüssel. Deshalb bekommt die View eine
	 * eigene Kennung in der .base-Datei — aber erst, wenn wirklich etwas zu
	 * speichern ist, damit unberührte Bases sauber bleiben.
	 */
	private boardId(): string {
		const id = this.config?.get("boardId");
		return typeof id === "string" ? id : "";
	}

	private ensureBoardId(): string {
		const existing = this.boardId();
		if (existing) return existing;
		const id = `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`;
		this.config?.set("boardId", id);
		return id;
	}

	private loadLocalState(): void {
		const id = this.boardId();
		if (!id) return;

		const raw = this.app.loadLocalStorage(LOCAL_STATE_PREFIX + id);
		if (!raw || typeof raw !== "object") return;

		const state = raw as { collapsed?: unknown; zoom?: unknown; filter?: unknown };
		this.collapsed = new Set(stringArray(state.collapsed));
		if (typeof state.zoom === "number") {
			this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.zoom));
		}
		if (typeof state.filter === "string") {
			this.filterQuery = state.filter;
			this.filterInput.value = state.filter;
			this.searchEl.toggleClass("has-query", state.filter.length > 0);
		}
		this.applyZoom();
	}

	private saveLocalState(): void {
		this.app.saveLocalStorage(LOCAL_STATE_PREFIX + this.ensureBoardId(), {
			collapsed: Array.from(this.collapsed),
			zoom: this.zoom,
			filter: this.filterQuery,
		});
	}

	/**
	 * Schreibt nur bei echter Änderung, sonst löst config.set() eine Render-Schleife aus.
	 *
	 * Die Kopie ist Pflicht: config speichert die Referenz, und ohne Kopie würde das
	 * spätere Mutieren von cardOrderPref auch den gespeicherten Wert mitverändern —
	 * der Vergleich sähe dann nie einen Unterschied und würde nie wieder schreiben.
	 */
	private persist(key: string, value: unknown): void {
		const next = JSON.stringify(value);
		if (JSON.stringify(this.config?.get(key) ?? null) === next) return;
		this.config?.set(key, JSON.parse(next));
	}

	// --- Render -----------------------------------------------------------

	render(): void {
		if (this.dragging) return;
		this.loadPrefs();
		this.destroySortables();
		this.boardEl.empty();

		const all: BasesEntry[] = this.data?.data ?? [];
		const entries = all.filter((entry) => this.matchesFilter(entry));
		this.updateCount(entries.length, all.length);

		if (all.length === 0) {
			this.boardEl.createDiv({
				cls: "wwe-board-empty",
				text: "Keine Projekte gefunden.",
			});
			return;
		}
		if (entries.length === 0) {
			this.boardEl.createDiv({
				cls: "wwe-board-empty",
				text: `Kein Treffer für "${this.filterQuery.trim()}".`,
			});
			return;
		}

		const groups = new Map<string, BasesEntry[]>();
		for (const entry of entries) {
			const status = text(entry, P.FORTSCHRITT) || NO_STATUS;
			const bucket = groups.get(status);
			if (bucket) bucket.push(entry);
			else groups.set(status, [entry]);
		}

		for (const status of this.columnOrder(groups)) {
			this.renderColumn(status, this.sortEntries(status, groups.get(status) ?? []));
		}

		this.applySelection();
		this.initSortables();
		this.restoreScroll();
	}

	private restoreScroll(): void {
		if (!this.restoreScrollPending) return;
		this.restoreScrollPending = false;

		const selected = this.plugin.selectedPath;
		if (!selected) return;

		// Erst im nächsten Frame — vorher steht die Breite des Boards noch nicht fest.
		window.requestAnimationFrame(() => {
			const cardEl = this.boardEl.querySelector(`[data-path="${CSS.escape(selected)}"]`);
			cardEl?.scrollIntoView({ block: "nearest", inline: "center" });
		});
	}

	/**
	 * Gespeicherte Reihenfolge gewinnt, sonst die Vorgabe. Statuswerte, die in
	 * keiner von beiden vorkommen, werden hinten angehängt statt verschluckt.
	 */
	private columnOrder(groups: Map<string, BasesEntry[]>): string[] {
		const base =
			this.columnOrderPref.length > 0 ? this.columnOrderPref : DEFAULT_STATUS_ORDER;
		const order = [...base];
		for (const status of groups.keys()) {
			if (!order.includes(status)) order.push(status);
		}
		return order;
	}

	/** Manuell sortierte Karten zuerst, neue Karten hinten. */
	private sortEntries(status: string, entries: BasesEntry[]): BasesEntry[] {
		const saved = this.cardOrderPref[status];
		if (!saved || saved.length === 0) return entries;

		const rank = new Map(saved.map((path, index) => [path, index]));
		return [...entries].sort((a, b) => {
			const rankA = rank.get(a.file.path) ?? Number.MAX_SAFE_INTEGER;
			const rankB = rank.get(b.file.path) ?? Number.MAX_SAFE_INTEGER;
			if (rankA !== rankB) return rankA - rankB;
			return a.file.path.localeCompare(b.file.path);
		});
	}

	private renderColumn(status: string, entries: BasesEntry[]): void {
		const collapsed = this.collapsed.has(status);

		const colEl = this.boardEl.createDiv({ cls: "wwe-col" });
		colEl.toggleClass("is-collapsed", collapsed);
		colEl.setAttribute("data-status", status);

		const headerEl = colEl.createDiv({ cls: "wwe-col-header" });

		const toggleEl = headerEl.createSpan({ cls: "wwe-col-toggle" });
		setIcon(toggleEl, collapsed ? "chevron-right" : "chevron-down");
		toggleEl.setAttribute(
			"aria-label",
			collapsed ? "Spalte ausklappen" : "Spalte einklappen"
		);
		toggleEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.toggleColumn(status);
		});

		const dotEl = headerEl.createSpan({ cls: "wwe-col-dot" });
		dotEl.style.setProperty("--wwe-hue", STATUS_HUE[status] ?? hueFor(status));
		headerEl.createSpan({ cls: "wwe-col-title", text: status });
		headerEl.createSpan({ cls: "wwe-col-count", text: String(entries.length) });

		if (collapsed) return;

		const addEl = headerEl.createSpan({ cls: "wwe-col-add" });
		setIcon(addEl, "plus");
		addEl.setAttribute("aria-label", `Neues Projekt in "${status}"`);
		addEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.openNewProjectModal(status);
		});

		const bodyEl = colEl.createDiv({ cls: "wwe-col-body" });
		bodyEl.setAttribute("data-status", status);
		for (const entry of entries) {
			// Zweiter Schutzwall: eine Karte, die sich partout nicht zeichnen lässt,
			// darf die restlichen Karten und vor allem initSortables() nicht mitreißen.
			try {
				this.renderCard(bodyEl, entry);
			} catch (error) {
				console.warn(
					`WWE Project Board: Karte für ${entry.file.path} konnte nicht gezeichnet werden.`,
					error
				);
			}
		}
	}

	private toggleColumn(status: string): void {
		if (this.collapsed.has(status)) this.collapsed.delete(status);
		else this.collapsed.add(status);
		this.saveLocalState();
		this.render();
	}

	private renderCard(parentEl: HTMLElement, entry: BasesEntry): void {
		const projektFolder = entry.file.parent?.name ?? "";
		const kundeFolder = entry.file.parent?.parent?.name ?? "";
		const projekt = text(entry, P.PROJEKT) || projektFolder;
		const kunde = text(entry, P.KUNDE) || kundeFolder;

		renderProjectCard(
			parentEl,
			{
				path: entry.file.path,
				projekt,
				chip: kunde,
				chipHue: hueFor(kunde),
				drift: driftOf(projekt, projektFolder, kunde, kundeFolder),
				owners: list(entry, P.OWNER),
				ansprechpartner: text(entry, P.ANSPRECHPARTNER),
				format: text(entry, P.FORMAT),
				tags: list(entry, P.TAGS),
				wiedervorlage: text(entry, P.WIEDERVORLAGE),
				deadline: text(entry, P.DEADLINE),
			},
			() => {
				this.select(entry.file.path);
				void this.app.workspace.getLeaf(false).openFile(entry.file);
			},
			() => this.openCustomer(entry.file, kunde)
		);
	}

	/** Die Karte bleibt markiert, damit man beim Zurückkehren sieht, wo man war. */
	private openCustomer(projectFile: TFile, kunde: string): void {
		const index = customerIndexOf(projectFile);
		if (!index) {
			new Notice(`Für "${kunde}" gibt es keine _index.md.`);
			return;
		}
		this.select(projectFile.path);
		void this.app.workspace.getLeaf(false).openFile(index);
	}

	// --- Auswahl ----------------------------------------------------------

	private select(path: string | null): void {
		if (this.plugin.selectedPath === path) return;
		this.plugin.selectedPath = path;
		this.applySelection();
	}

	private applySelection(): void {
		const selected = this.plugin.selectedPath;
		this.boardEl.querySelectorAll(".wwe-card").forEach((el) => {
			el.classList.toggle(
				"wwe-card-selected",
				el.getAttribute("data-path") === selected
			);
		});
	}

	// --- Neues Projekt ----------------------------------------------------

	/**
	 * Die Kundenordner sind die Großeltern der Projektdateien. Liegen alle unter
	 * demselben Wurzelordner, listen wir dessen Unterordner — dann erscheinen auch
	 * Kunden, die noch kein Projekt haben.
	 */
	private customerFolders(): TFolder[] {
		const roots = new Map<string, TFolder>();
		const fromEntries = new Map<string, TFolder>();

		for (const entry of this.data?.data ?? []) {
			const kundeFolder = entry.file.parent?.parent;
			if (!kundeFolder) continue;
			fromEntries.set(kundeFolder.path, kundeFolder);
			if (kundeFolder.parent) roots.set(kundeFolder.parent.path, kundeFolder.parent);
		}

		const byName = (a: TFolder, b: TFolder) => a.name.localeCompare(b.name);

		if (roots.size === 1) {
			const root = Array.from(roots.values())[0];
			const folders = root.children.filter(
				(child): child is TFolder => child instanceof TFolder
			);
			if (folders.length > 0) return folders.sort(byName);
		}
		return Array.from(fromEntries.values()).sort(byName);
	}

	private openNewProjectModal(status: string): void {
		new NewProjectModal(this.app, this.customerFolders(), (folder, name) => {
			void this.createProject(folder, name, status);
		}).open();
	}

	private async createProject(
		folder: TFolder,
		name: string,
		status: string
	): Promise<void> {
		const projectPath = `${folder.path}/${name}`;
		if (this.app.vault.getAbstractFileByPath(projectPath)) {
			new Notice(`"${name}" gibt es bei ${folder.name} schon.`);
			return;
		}

		try {
			await this.app.vault.createFolder(projectPath);
			const file = await this.app.vault.create(
				`${projectPath}/_index.md`,
				newProjectNote(name, folder.name, status)
			);
			this.plugin.selectedPath = file.path;
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (error) {
			new Notice(`Projekt konnte nicht angelegt werden: ${error}`);
			console.error("WWE Project Board:", error);
		}
	}

	// --- Drag and drop ----------------------------------------------------

	private destroySortables(): void {
		for (const sortable of this.sortables) sortable.destroy();
		this.sortables = [];
	}

	/**
	 * Das Board hängt an einem CSS-`zoom`. Sortable rechnet beim Positionieren
	 * der schwebenden Kopie nicht damit: bei 80 % lief sie dem Cursor sichtbar
	 * davon, sodass man nicht zielen konnte. Ablegen und Einsortieren stimmten
	 * zwar weiterhin, weil das über die Cursorposition läuft — brauchbar war es
	 * trotzdem nicht.
	 *
	 * forceFallback lässt Sortable eine eigene Kopie zeichnen, fallbackOnBody
	 * hängt sie an den body und damit aus dem gezoomten Bereich heraus. Dort
	 * gelten wieder unverfälschte Bildschirmkoordinaten.
	 */
	private get dragOptions(): Sortable.Options {
		return {
			animation: 150,
			ghostClass: "wwe-drag-ghost",
			forceFallback: true,
			fallbackOnBody: true,
			fallbackClass: "wwe-drag-floating",
		};
	}

	private initSortables(): void {
		this.sortables.push(
			Sortable.create(this.boardEl, {
				...this.dragOptions,
				group: "wwe-columns",
				draggable: ".wwe-col",
				handle: ".wwe-col-header",
				filter: ".wwe-col-add, .wwe-col-toggle",
				preventOnFilter: false,
				onStart: () => {
					this.dragging = true;
				},
				onEnd: () => {
					this.dragging = false;
					this.captureColumnOrder();
				},
			})
		);

		this.boardEl.querySelectorAll<HTMLElement>(".wwe-col-body").forEach((bodyEl) => {
			this.sortables.push(
				Sortable.create(bodyEl, {
					...this.dragOptions,
					group: "wwe-cards",
					draggable: ".wwe-card",
					onStart: () => {
						this.dragging = true;
					},
					onEnd: (evt) => {
						this.dragging = false;
						void this.handleCardDrop(evt);
					},
				})
			);
		});
	}

	private captureColumnOrder(): void {
		const order = Array.from(this.boardEl.querySelectorAll(".wwe-col"))
			.map((el) => el.getAttribute("data-status"))
			.filter((status): status is string => !!status);
		this.columnOrderPref = order;
		this.persist("columnOrder", order);
	}

	private captureCardOrder(bodyEl: HTMLElement): void {
		const status = bodyEl.getAttribute("data-status");
		if (!status) return;
		this.cardOrderPref[status] = Array.from(bodyEl.querySelectorAll(".wwe-card"))
			.map((el) => el.getAttribute("data-path"))
			.filter((path): path is string => !!path);
	}

	/** Verhindert, dass ein Pfad in der Reihenfolge seiner alten Spalte zurückbleibt. */
	private pruneFromOtherColumns(path: string, keepStatus: string): void {
		for (const [status, paths] of Object.entries(this.cardOrderPref)) {
			if (status === keepStatus) continue;
			const remaining = paths.filter((candidate) => candidate !== path);
			if (remaining.length !== paths.length) this.cardOrderPref[status] = remaining;
		}
	}

	private async handleCardDrop(evt: Sortable.SortableEvent): Promise<void> {
		const fromEl = evt.from;
		const toEl = evt.to;
		const path = evt.item.getAttribute("data-path");
		const status = toEl.getAttribute("data-status");

		this.captureCardOrder(fromEl);
		if (toEl !== fromEl) {
			this.captureCardOrder(toEl);
			if (path && status) this.pruneFromOtherColumns(path, status);
		}
		this.persist("cardOrder", this.cardOrderPref);

		if (toEl === fromEl) return;
		if (!path || !status) return;

		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			frontmatter.fortschritt = status === NO_STATUS ? null : status;
		});
	}
}

class NewProjectModal extends Modal {
	private folders: TFolder[];
	private onSubmit: (folder: TFolder, name: string) => void;

	private selected: TFolder | null = null;
	private matches: TFolder[] = [];
	private activeIndex = 0;

	private customerInput!: HTMLInputElement;
	private listEl!: HTMLElement;
	private nameInput!: HTMLInputElement;

	constructor(
		app: App,
		folders: TFolder[],
		onSubmit: (folder: TFolder, name: string) => void
	) {
		super(app);
		this.folders = folders;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.modalEl.addClass("wwe-modal");
		this.titleEl.setText("Neues Projekt");
		const { contentEl } = this;

		if (this.folders.length === 0) {
			contentEl.createEl("p", {
				cls: "wwe-modal-hint",
				text: "Kein Kundenordner gefunden. Das Board braucht mindestens ein bestehendes Projekt, um die Kundenordner zu erkennen.",
			});
			return;
		}

		const customerField = contentEl.createDiv({ cls: "wwe-field" });
		customerField.createEl("label", { cls: "wwe-field-label", text: "Kunde" });
		const comboEl = customerField.createDiv({ cls: "wwe-combo" });
		this.customerInput = comboEl.createEl("input", {
			cls: "wwe-combo-input",
			attr: { type: "text", placeholder: "Tippen zum Suchen" },
		});
		this.listEl = comboEl.createDiv({ cls: "wwe-combo-list" });

		const nameField = contentEl.createDiv({ cls: "wwe-field" });
		nameField.createEl("label", { cls: "wwe-field-label", text: "Projektname" });
		this.nameInput = nameField.createEl("input", {
			attr: { type: "text", placeholder: "Projekt 10" },
		});

		const actionsEl = contentEl.createDiv({ cls: "wwe-actions" });
		actionsEl
			.createEl("button", { text: "Abbrechen" })
			.addEventListener("click", () => this.close());
		actionsEl
			.createEl("button", { cls: "mod-cta", text: "Anlegen" })
			.addEventListener("click", () => this.submit());

		this.customerInput.addEventListener("input", () => {
			this.selected = null;
			this.refreshMatches();
		});
		this.customerInput.addEventListener("keydown", (evt) => this.onComboKeydown(evt));
		this.nameInput.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter") return;
			evt.preventDefault();
			this.submit();
		});

		this.refreshMatches();
		window.setTimeout(() => this.customerInput.focus(), 0);
	}

	// --- Kunden-Auswahl ---------------------------------------------------

	private refreshMatches(): void {
		const query = foldText(this.customerInput.value.trim());
		this.matches = query
			? this.folders.filter((folder) => foldText(folder.name).includes(query))
			: [...this.folders];
		this.activeIndex = 0;
		this.renderList();
	}

	private renderList(): void {
		this.listEl.empty();

		if (this.matches.length === 0) {
			this.listEl.createDiv({ cls: "wwe-combo-empty", text: "Kein Treffer" });
			return;
		}

		const visible = this.matches.slice(0, MAX_VISIBLE_CUSTOMERS);
		visible.forEach((folder, index) => {
			const itemEl = this.listEl.createDiv({
				cls: "wwe-combo-item",
				text: folder.name,
			});
			itemEl.toggleClass("is-active", index === this.activeIndex);
			itemEl.toggleClass("is-selected", this.selected?.path === folder.path);
			// mousedown statt click: sonst verliert das Eingabefeld vorher den Fokus.
			itemEl.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				this.pick(folder);
			});
		});

		const hidden = this.matches.length - visible.length;
		if (hidden > 0) {
			this.listEl.createDiv({
				cls: "wwe-combo-more",
				text: `+ ${hidden} weitere — weiter tippen`,
			});
		}
	}

	private pick(folder: TFolder): void {
		this.selected = folder;
		this.customerInput.value = folder.name;
		this.refreshMatches();
		this.nameInput.focus();
	}

	private onComboKeydown(evt: KeyboardEvent): void {
		if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
			evt.preventDefault();
			const count = Math.min(this.matches.length, MAX_VISIBLE_CUSTOMERS);
			if (count === 0) return;
			const step = evt.key === "ArrowDown" ? 1 : -1;
			this.activeIndex = (this.activeIndex + step + count) % count;
			this.renderList();
			return;
		}

		if (evt.key === "Enter") {
			evt.preventDefault();
			const folder = this.matches[this.activeIndex];
			if (folder) this.pick(folder);
		}
	}

	/** Ohne Klick auf die Liste zählt auch ein exakt eingetippter Kundenname. */
	private resolveFolder(): TFolder | null {
		if (this.selected) return this.selected;
		const query = foldText(this.customerInput.value.trim());
		if (!query) return null;
		const exact = this.folders.filter((folder) => foldText(folder.name) === query);
		return exact.length === 1 ? exact[0] : null;
	}

	private submit(): void {
		const folder = this.resolveFolder();
		if (!folder) {
			new Notice("Bitte einen Kunden auswählen.");
			this.customerInput.focus();
			return;
		}

		const name = this.nameInput.value.trim();
		if (!name) {
			new Notice("Bitte einen Projektnamen angeben.");
			this.nameInput.focus();
			return;
		}
		if (/[\\/:]/.test(name)) {
			new Notice("Der Projektname darf kein / \\ oder : enthalten.");
			return;
		}

		this.close();
		this.onSubmit(folder, name);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export default class WweProjectBoardPlugin extends Plugin {
	/** Zuletzt angeklickte Karte — überlebt das Wegnavigieren zur Projektdatei. */
	selectedPath: string | null = null;

	/** Ob Obsidians roher Dateikopf im Deckblatt sichtbar ist. Pro Gerät. */
	private showChrome = false;

	/** Ob das Eigenschaften-Panel links aufgeklappt ist. Pro Gerät. */
	private showPanel = false;

	async onload(): Promise<void> {
		this.registerBasesView(VIEW_TYPE, {
			name: "Project Board",
			icon: "layout-grid",
			factory: (controller, containerEl) =>
				new ProjectBoardView(controller, containerEl, this),
		});

		this.showChrome = this.app.loadLocalStorage(SHOW_CHROME_KEY) === true;
		this.showPanel = this.app.loadLocalStorage(SHOW_PANEL_KEY) === true;

		this.addCommand({
			id: "toggle-cover-panel",
			name: "Deckblatt: Eigenschaften-Panel ein-/ausklappen",
			callback: () => this.togglePanel(),
		});

		this.addCommand({
			id: "toggle-cover-chrome",
			name: "Deckblatt: Obsidians Dateikopf ein-/ausblenden",
			callback: () => this.toggleChrome(),
		});

		this.registerEvent(this.app.workspace.on("file-open", () => this.decorateAll()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.decorateAll()));
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.basename === "_index") this.decorateAll();
			})
		);
		this.app.workspace.onLayoutReady(() => this.decorateAll());
	}

	onunload(): void {
		for (const view of this.markdownViews()) this.undecorate(view);
	}

	private markdownViews(): MarkdownView[] {
		return this.app.workspace
			.getLeavesOfType("markdown")
			.map((leaf) => leaf.view)
			.filter((view): view is MarkdownView => view instanceof MarkdownView);
	}

	/** Deckblätter sind _index.md — als Projekt oder als Kunde. */
	private coverKind(file: TFile): "projekt" | "kunde" | null {
		if (file.basename !== "_index") return null;
		const typ = this.app.metadataCache.getFileCache(file)?.frontmatter?.typ;
		if (typ === "projekt") return "projekt";
		if (typ === "kunde") return "kunde";
		return null;
	}

	private frontmatterOf(file: TFile): Record<string, unknown> {
		return this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	}

	/** Die _index.md aller Projektordner unterhalb eines Kundenordners. */
	private projectsOf(customerFolder: TFolder): TFile[] {
		const files: TFile[] = [];
		for (const child of customerFolder.children) {
			if (!(child instanceof TFolder)) continue;
			const index = child.children.find(
				(candidate): candidate is TFile =>
					candidate instanceof TFile && candidate.name === "_index.md"
			);
			if (index && this.coverKind(index) === "projekt") files.push(index);
		}
		return files.sort((a, b) => {
			const rankA = DEFAULT_STATUS_ORDER.indexOf(
				String(this.frontmatterOf(a).fortschritt ?? "")
			);
			const rankB = DEFAULT_STATUS_ORDER.indexOf(
				String(this.frontmatterOf(b).fortschritt ?? "")
			);
			if (rankA !== rankB) return (rankA < 0 ? 99 : rankA) - (rankB < 0 ? 99 : rankB);
			return a.path.localeCompare(b.path);
		});
	}

	private openFile(file: TFile): void {
		this.selectedPath = file.path;
		void this.app.workspace.getLeaf(false).openFile(file);
	}

	private toggleChrome(): void {
		this.showChrome = !this.showChrome;
		this.app.saveLocalStorage(SHOW_CHROME_KEY, this.showChrome);
		this.decorateAll(true);
	}

	private togglePanel(): void {
		this.showPanel = !this.showPanel;
		this.app.saveLocalStorage(SHOW_PANEL_KEY, this.showPanel);
		this.decorateAll(true);
	}

	private decorateAll(rebuild = false): void {
		for (const view of this.markdownViews()) {
			const file = view.file;
			const kind = file ? this.coverKind(file) : null;
			if (file && kind) this.decorate(view, file, kind, rebuild);
			else this.undecorate(view);
		}
	}

	private decorate(
		view: MarkdownView,
		file: TFile,
		kind: "projekt" | "kunde",
		rebuild: boolean
	): void {
		const { contentEl } = view;
		contentEl.addClass(COVER_CLASS);
		contentEl.toggleClass(COVER_CHROME_CLASS, this.showChrome);
		contentEl.toggleClass(COVER_PANEL_OPEN_CLASS, this.showPanel && kind === "projekt");

		const headerEl = contentEl.querySelector<HTMLElement>(`.${COVER_HEADER_CLASS}`);

		// Nur neu aufbauen, wenn nötig. Sonst würde jede Frontmatter-Änderung —
		// also auch die eigene — dem Nutzer das Eingabefeld unter den Fingern
		// wegreißen, während er tippt.
		if (headerEl?.dataset.path === file.path && !rebuild) return;

		headerEl?.remove();
		contentEl.querySelector(`.${COVER_PANEL_CLASS}`)?.remove();
		contentEl.querySelector(`.${COVER_PROJECTS_CLASS}`)?.remove();

		if (kind === "projekt") {
			this.buildPanel(contentEl, file);
			this.buildProjectHeader(contentEl, file);
		} else {
			this.buildProjectList(contentEl, file);
			this.buildCustomerHeader(contentEl, file);
		}
	}

	private buildProjectHeader(contentEl: HTMLElement, file: TFile): void {
		const frontmatter = this.frontmatterOf(file);
		const projekt =
			typeof frontmatter.projekt === "string" && frontmatter.projekt
				? frontmatter.projekt
				: file.parent?.name ?? file.basename;
		const kunde =
			typeof frontmatter.kunde === "string" && frontmatter.kunde
				? frontmatter.kunde
				: file.parent?.parent?.name ?? "";

		const headerEl = this.newHeader(contentEl, file);

		const toggleEl = headerEl.createSpan({ cls: "wwe-cover-toggle" });
		setIcon(toggleEl, this.showPanel ? "panel-left-close" : "panel-left-open");
		toggleEl.setAttribute(
			"aria-label",
			this.showPanel ? "Eigenschaften einklappen" : "Eigenschaften ausklappen"
		);
		toggleEl.addEventListener("click", () => this.togglePanel());

		if (kunde) {
			const kundeEl = headerEl.createSpan({
				cls: "wwe-cover-kunde is-link",
				text: kunde,
			});
			kundeEl.style.setProperty("--wwe-hue", hueFor(kunde));
			kundeEl.setAttribute("aria-label", `Zur Seite von ${kunde}`);
			kundeEl.addEventListener("click", () => this.openCustomer(file, kunde));
		}
		headerEl.createSpan({ cls: "wwe-cover-title", text: projekt });
	}

	private buildCustomerHeader(contentEl: HTMLElement, file: TFile): void {
		const headerEl = this.newHeader(contentEl, file);
		const kunde = file.parent?.name ?? file.basename;

		const iconEl = headerEl.createSpan({ cls: "wwe-cover-icon" });
		setIcon(iconEl, "building-2");
		headerEl.createSpan({ cls: "wwe-cover-title", text: kunde });
	}

	private newHeader(contentEl: HTMLElement, file: TFile): HTMLElement {
		const headerEl = createDiv({ cls: COVER_HEADER_CLASS });
		headerEl.dataset.path = file.path;
		contentEl.prepend(headerEl);
		return headerEl;
	}

	private openCustomer(projectFile: TFile, kunde: string): void {
		const index = customerIndexOf(projectFile);
		if (!index) {
			new Notice(`Für "${kunde}" gibt es keine _index.md.`);
			return;
		}
		this.openFile(index);
	}

	private buildProjectList(contentEl: HTMLElement, file: TFile): void {
		const listEl = createDiv({ cls: COVER_PROJECTS_CLASS });
		contentEl.prepend(listEl);

		const customerFolder = file.parent;
		if (!customerFolder) return;

		const projects = this.projectsOf(customerFolder);
		listEl.createDiv({
			cls: "wwe-projects-heading",
			text: projects.length === 1 ? "1 Projekt" : `${projects.length} Projekte`,
		});

		for (const projectFile of projects) {
			const frontmatter = this.frontmatterOf(projectFile);
			const projektFolder = projectFile.parent?.name ?? "";
			const kundeFolder = projectFile.parent?.parent?.name ?? "";
			const projekt = fmText(frontmatter.projekt) || projektFolder;
			const kunde = fmText(frontmatter.kunde) || kundeFolder;
			const status = fmText(frontmatter.fortschritt);

			renderProjectCard(
				listEl,
				{
					path: projectFile.path,
					projekt,
					chip: status,
					chipHue: STATUS_HUE[status] ?? hueFor(status),
					drift: driftOf(projekt, projektFolder, kunde, kundeFolder),
					owners: fmList(frontmatter.owner),
					ansprechpartner: fmText(frontmatter.ansprechpartner),
					format: fmText(frontmatter.format),
					tags: fmList(frontmatter.tags),
					wiedervorlage: fmText(frontmatter.wiedervorlage),
					deadline: fmText(frontmatter.deadline),
				},
				() => this.openFile(projectFile)
			);
		}
	}

	private buildPanel(contentEl: HTMLElement, file: TFile): void {
		const panelEl = createDiv({ cls: COVER_PANEL_CLASS });
		contentEl.prepend(panelEl);
		if (!this.showPanel) return;

		const frontmatter = this.frontmatterOf(file);
		for (const field of COVER_FIELDS) {
			this.buildField(panelEl, file, field, frontmatter[field.key]);
		}
	}

	private buildField(
		panelEl: HTMLElement,
		file: TFile,
		field: CoverField,
		raw: unknown
	): void {
		const fieldEl = panelEl.createDiv({ cls: "wwe-cover-field" });
		fieldEl.createEl("label", { cls: "wwe-cover-label", text: field.label });

		if (field.kind === "select") {
			const selectEl = fieldEl.createEl("select");
			const current = typeof raw === "string" ? raw : "";
			const options = [...DEFAULT_STATUS_ORDER];
			if (current && !options.includes(current)) options.push(current);
			selectEl.createEl("option", { value: "", text: "—" });
			for (const option of options) {
				selectEl.createEl("option", { value: option, text: option });
			}
			selectEl.value = current;
			selectEl.addEventListener("change", () => {
				void this.writeFrontmatter(file, field.key, selectEl.value || null);
			});
			return;
		}

		const rowEl = field.locked
			? fieldEl.createDiv({ cls: "wwe-cover-lockrow" })
			: fieldEl;
		const inputEl = rowEl.createEl("input", {
			attr: { type: field.kind === "date" ? "date" : "text" },
		});

		if (field.locked) {
			inputEl.readOnly = true;
			const lockEl = rowEl.createSpan({ cls: "wwe-cover-lock" });
			setIcon(lockEl, "lock");
			lockEl.setAttribute("aria-label", "Zum Ändern aufschließen");
			lockEl.addEventListener("click", () => {
				inputEl.readOnly = !inputEl.readOnly;
				lockEl.empty();
				setIcon(lockEl, inputEl.readOnly ? "lock" : "unlock");
				lockEl.toggleClass("is-open", !inputEl.readOnly);
				lockEl.setAttribute(
					"aria-label",
					inputEl.readOnly ? "Zum Ändern aufschließen" : "Wieder abschließen"
				);
				if (!inputEl.readOnly) inputEl.focus();
			});
		}

		if (field.kind === "list") {
			inputEl.value = Array.isArray(raw) ? raw.map(String).join(", ") : String(raw ?? "");
			inputEl.placeholder = "durch Komma getrennt";
		} else {
			inputEl.value = raw === null || raw === undefined ? "" : String(raw);
		}

		const commit = () => {
			if (field.kind === "list") {
				const parts = inputEl.value
					.split(/\s*,\s*/)
					.map((part) => part.trim())
					.filter(Boolean);
				void this.writeFrontmatter(file, field.key, parts.length > 0 ? parts : null);
				return;
			}
			void this.writeFrontmatter(file, field.key, inputEl.value.trim() || null);
		};

		// Datum meldet sich über change, Text erst beim Verlassen — sonst würde
		// nach jedem Tastendruck in die Datei geschrieben.
		inputEl.addEventListener(field.kind === "date" ? "change" : "blur", commit);
		inputEl.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter") return;
			evt.preventDefault();
			inputEl.blur();
		});
	}

	private async writeFrontmatter(
		file: TFile,
		key: string,
		value: unknown
	): Promise<void> {
		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				frontmatter[key] = value;
			});
		} catch (error) {
			new Notice(`Eigenschaft konnte nicht gespeichert werden: ${error}`);
			console.error("WWE Project Board:", error);
		}
	}

	private undecorate(view: MarkdownView): void {
		const { contentEl } = view;
		if (!contentEl.hasClass(COVER_CLASS)) return;
		contentEl.removeClass(COVER_CLASS);
		contentEl.removeClass(COVER_CHROME_CLASS);
		contentEl.removeClass(COVER_PANEL_OPEN_CLASS);
		contentEl.querySelector(`.${COVER_HEADER_CLASS}`)?.remove();
		contentEl.querySelector(`.${COVER_PANEL_CLASS}`)?.remove();
		contentEl.querySelector(`.${COVER_PROJECTS_CLASS}`)?.remove();
	}
}
