import {
	BasesEntry,
	BasesPropertyId,
	BasesView,
	Plugin,
	QueryController,
	TFile,
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

function text(entry: BasesEntry, prop: BasesPropertyId): string {
	const value = entry.getValue(prop);
	if (!value || !value.isTruthy()) return "";
	return value.toString().trim();
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

class ProjectBoardView extends BasesView {
	type = VIEW_TYPE;
	boardEl: HTMLElement;
	plugin: WweProjectBoardPlugin;

	private sortables: Sortable[] = [];
	private prefsLoaded = false;
	private columnOrderPref: string[] = [];
	private cardOrderPref: Record<string, string[]> = {};

	/**
	 * Während eines Drags nicht neu rendern — sonst reißt Sortable die
	 * Live-Vorschau unter dem Cursor weg.
	 */
	private dragging = false;

	private scheduleRender: () => void;

	constructor(
		controller: QueryController,
		containerEl: HTMLElement,
		plugin: WweProjectBoardPlugin
	) {
		super(controller);
		this.plugin = plugin;
		this.boardEl = containerEl.createDiv({ cls: "wwe-board" });

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

	// --- Persistenz -------------------------------------------------------

	private loadPrefs(): void {
		if (this.prefsLoaded) return;
		this.columnOrderPref = stringArray(this.config?.get("columnOrder"));
		this.cardOrderPref = orderMap(this.config?.get("cardOrder"));
		this.prefsLoaded = true;
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

		const entries: BasesEntry[] = this.data?.data ?? [];
		if (entries.length === 0) {
			this.boardEl.createDiv({
				cls: "wwe-board-empty",
				text: "Keine Projekte gefunden.",
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
		const colEl = this.boardEl.createDiv({ cls: "wwe-col" });
		colEl.setAttribute("data-status", status);

		const headerEl = colEl.createDiv({ cls: "wwe-col-header" });
		const dotEl = headerEl.createSpan({ cls: "wwe-col-dot" });
		dotEl.style.setProperty("--wwe-hue", STATUS_HUE[status] ?? hueFor(status));
		headerEl.createSpan({ cls: "wwe-col-title", text: status });
		headerEl.createSpan({ cls: "wwe-col-count", text: String(entries.length) });

		const bodyEl = colEl.createDiv({ cls: "wwe-col-body" });
		bodyEl.setAttribute("data-status", status);
		for (const entry of entries) {
			this.renderCard(bodyEl, entry);
		}
	}

	private renderCard(parentEl: HTMLElement, entry: BasesEntry): void {
		const projektFolder = entry.file.parent?.name ?? "";
		const kundeFolder = entry.file.parent?.parent?.name ?? "";
		const projekt = text(entry, P.PROJEKT) || projektFolder;
		const kunde = text(entry, P.KUNDE) || kundeFolder;

		const drift: string[] = [];
		if (projektFolder && projekt !== projektFolder) {
			drift.push(`Projektordner heißt "${projektFolder}"`);
		}
		if (kundeFolder && kunde !== kundeFolder) {
			drift.push(`Kundenordner heißt "${kundeFolder}"`);
		}

		const cardEl = parentEl.createDiv({ cls: "wwe-card" });
		cardEl.setAttribute("data-path", entry.file.path);

		const headEl = cardEl.createDiv({ cls: "wwe-card-head" });
		if (kunde) {
			const kundeEl = headEl.createSpan({ cls: "wwe-kunde", text: kunde });
			kundeEl.style.setProperty("--wwe-hue", hueFor(kunde));
		}
		if (drift.length > 0) {
			const warnEl = headEl.createSpan({ cls: "wwe-warn" });
			setIcon(warnEl, "alert-triangle");
			warnEl.setAttribute("aria-label", drift.join(" · "));
		}
		const owners = list(entry, P.OWNER);
		if (owners.length > 0) {
			const avatarsEl = headEl.createDiv({ cls: "wwe-avatars" });
			for (const owner of owners) {
				const avatarEl = avatarsEl.createSpan({
					cls: "wwe-avatar",
					text: initials(owner),
				});
				avatarEl.style.setProperty("--wwe-hue", hueFor(owner));
				avatarEl.setAttribute("aria-label", owner);
			}
		}

		const titleEl = cardEl.createDiv({ cls: "wwe-card-title", text: projekt });
		titleEl.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.select(entry.file.path);
			void this.app.workspace.getLeaf(false).openFile(entry.file);
		});

		const metaEl = cardEl.createDiv({ cls: "wwe-meta" });
		this.renderMetaRow(metaEl, "user", text(entry, P.ANSPRECHPARTNER));
		this.renderMetaRow(metaEl, "presentation", text(entry, P.FORMAT));
		if (metaEl.childElementCount === 0) metaEl.remove();

		const tags = list(entry, P.TAGS);
		if (tags.length > 0) {
			const tagsEl = cardEl.createDiv({ cls: "wwe-tags" });
			for (const tag of tags) {
				tagsEl.createSpan({ cls: "wwe-tag", text: tag.replace(/^#/, "") });
			}
		}

		const wiedervorlage = text(entry, P.WIEDERVORLAGE);
		const deadline = text(entry, P.DEADLINE);
		if (wiedervorlage || deadline) {
			const footEl = cardEl.createDiv({ cls: "wwe-card-foot" });
			if (wiedervorlage) {
				this.renderBadge(footEl, "wwe-badge-wv", "clock", "Wiedervorlage", wiedervorlage);
			}
			if (deadline) {
				this.renderBadge(footEl, "wwe-badge-dl", "flag", "Deadline", deadline);
			}
		}
	}

	private renderMetaRow(parentEl: HTMLElement, icon: string, value: string): void {
		if (!value) return;
		const rowEl = parentEl.createDiv({ cls: "wwe-meta-row" });
		setIcon(rowEl.createSpan({ cls: "wwe-meta-icon" }), icon);
		rowEl.createSpan({ text: value });
	}

	private renderBadge(
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

	// --- Drag and drop ----------------------------------------------------

	private destroySortables(): void {
		for (const sortable of this.sortables) sortable.destroy();
		this.sortables = [];
	}

	private initSortables(): void {
		this.sortables.push(
			Sortable.create(this.boardEl, {
				group: "wwe-columns",
				draggable: ".wwe-col",
				handle: ".wwe-col-header",
				animation: 150,
				ghostClass: "wwe-drag-ghost",
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
					group: "wwe-cards",
					draggable: ".wwe-card",
					animation: 150,
					ghostClass: "wwe-drag-ghost",
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

export default class WweProjectBoardPlugin extends Plugin {
	/** Zuletzt angeklickte Karte — überlebt das Wegnavigieren zur Projektdatei. */
	selectedPath: string | null = null;

	async onload(): Promise<void> {
		this.registerBasesView(VIEW_TYPE, {
			name: "Project Board",
			icon: "layout-grid",
			factory: (controller, containerEl) =>
				new ProjectBoardView(controller, containerEl, this),
		});
	}

	onunload(): void {}
}
