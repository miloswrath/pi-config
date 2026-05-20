import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { homedir, userInfo } from "node:os";

interface WorkItem {
	id: number;
	text: string;
	line: number;
	completed: boolean;
}

interface NoteDoc {
	path: string;
	relativePath: string;
	basename: string;
	title: string;
	content: string;
	lower: string;
	isProject: boolean;
}

interface RelatedNote {
	title: string;
	path: string;
	relativePath: string;
	score: number;
	reason: string;
	explicit: boolean;
}

interface TaskReport {
	item: WorkItem;
	related: RelatedNote[];
	missingLinkNote?: string;
}

interface BrainTodosReport {
	date: string;
	notesRoot: string;
	dailyNotePath?: string;
	dailyNoteRelativePath?: string;
	items: TaskReport[];
	allTasksCount: number;
	openTasksCount: number;
	searchedNotesCount: number;
	inspiration: string;
	warnings: string[];
}

const BrainTodosParams = Type.Object({
	date: Type.Optional(Type.String({ description: "Date to inspect, in YYYY-MM-DD format. Defaults to today." })),
	notesRoot: Type.Optional(
		Type.String({ description: "Notes vault root. Defaults to ~/notes/brain-1." }),
	),
	includeCompleted: Type.Optional(Type.Boolean({ description: "Include completed tasks too. Defaults to false." })),
	maxLinksPerTask: Type.Optional(Type.Number({ description: "Maximum related notes per task. Defaults to 3." })),
});

const BRAIN_TODOS_ONLY_RESPONSE_INSTRUCTION = [
	"When satisfying this user request with brain_todos, call the tool and then stop.",
	"Do not write any assistant follow-up, acknowledgement, summary, validation note, or extra prose after the brain_todos tool result.",
	"The visible brain_todos tool output is the complete answer.",
].join(" ");

type BrainTodosParamsType = {
	date?: string;
	notesRoot?: string;
	includeCompleted?: boolean;
	maxLinksPerTask?: number;
};

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"that",
	"this",
	"today",
	"todo",
	"task",
	"tasks",
	"work",
	"look",
	"into",
	"out",
	"next",
	"build",
	"meeting",
	"meetings",
	"issue",
	"issues",
	"main",
	"yml",
]);

function localDateString(date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function expandHome(path: string): string {
	return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function stripMarkdown(value: string): string {
	return value
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => alias || target)
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
		.replace(/[*_~]/g, "")
		.trim();
}

function tokenize(value: string): string[] {
	const normalized = stripMarkdown(value)
		.toLowerCase()
		.replace(/[\/_-]+/g, " ")
		.match(/[a-z0-9]+/g);
	if (!normalized) return [];
	return Array.from(new Set(normalized.filter((token) => token.length > 2 && !STOPWORDS.has(token))));
}

function extractTitle(content: string, fallback: string): string {
	const h1 = content.match(/^#\s+(.+)$/m)?.[1];
	return normalizeWhitespace(stripMarkdown(h1 || fallback.replace(/\.md$/i, "")));
}

async function listMarkdownFiles(root: string, signal?: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	const ignored = new Set([".git", "node_modules", ".obsidian", ".trash"]);

	async function walk(dir: string) {
		if (signal?.aborted) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (signal?.aborted) return;
			if (ignored.has(entry.name)) continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				files.push(fullPath);
			}
		}
	}

	await walk(root);
	return files.sort();
}

async function readDailyFolder(root: string): Promise<string> {
	const configPath = join(root, ".obsidian", "daily-notes.json");
	try {
		const raw = await readFile(configPath, "utf8");
		const parsed = JSON.parse(raw) as { folder?: string };
		return parsed.folder || "Ω/todos";
	} catch {
		return "Ω/todos";
	}
}

async function findDailyNote(root: string, date: string, markdownFiles: string[]): Promise<string | undefined> {
	const folder = await readDailyFolder(root);
	const configured = join(root, folder, `${date}.md`);
	if (existsSync(configured)) return configured;
	return markdownFiles.find((file) => basename(file) === `${date}.md`);
}

function extractWorkItems(content: string, includeCompleted: boolean): { selected: WorkItem[]; all: WorkItem[] } {
	const lines = content.split(/\r?\n/);
	const all: WorkItem[] = [];

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const task = line.match(/^\s*[-*+]\s+\[([ xX-])\]\s+(.+)$/);
		if (!task) continue;
		const completed = task[1].toLowerCase() === "x";
		all.push({
			id: all.length + 1,
			text: normalizeWhitespace(task[2]),
			line: index + 1,
			completed,
		});
	}

	// Fallback for looser daily notes: bullets under a "Tasks" heading count as work items.
	if (all.length === 0) {
		let inTasksSection = false;
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			if (/^#{1,6}\s+tasks\b/i.test(line.trim())) {
				inTasksSection = true;
				continue;
			}
			if (inTasksSection && /^#{1,6}\s+/.test(line.trim())) break;
			const bullet = inTasksSection ? line.match(/^\s*[-*+]\s+(.+)$/) : undefined;
			if (!bullet || /^-{3,}$/.test(bullet[1].trim())) continue;
			all.push({
				id: all.length + 1,
				text: normalizeWhitespace(bullet[1]),
				line: index + 1,
				completed: false,
			});
		}
	}

	return {
		all,
		selected: includeCompleted ? all : all.filter((item) => !item.completed),
	};
}

function extractWikiTargets(text: string): string[] {
	const targets: string[] = [];
	for (const match of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
		targets.push(match[1].trim());
	}
	return targets;
}

function extractMarkdownLinkTargets(text: string): string[] {
	const targets: string[] = [];
	for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
		const target = match[1].trim();
		if (!/^https?:\/\//i.test(target) && !target.startsWith("#")) targets.push(target);
	}
	return targets;
}

function buildNoteIndex(root: string, docs: NoteDoc[]): Map<string, NoteDoc> {
	const index = new Map<string, NoteDoc>();
	for (const doc of docs) {
		const noExtRelative = doc.relativePath.replace(/\.md$/i, "");
		for (const key of [doc.basename, doc.title, noExtRelative, doc.relativePath]) {
			index.set(key.toLowerCase(), doc);
		}
		index.set(resolve(root, doc.relativePath).toLowerCase(), doc);
	}
	return index;
}

function resolveLinkedNote(target: string, root: string, dailyDir: string, index: Map<string, NoteDoc>): NoteDoc | undefined {
	const cleanTarget = target.replace(/#.*$/, "").replace(/\.md$/i, "").trim();
	if (!cleanTarget) return undefined;

	const directKeys = [cleanTarget, `${cleanTarget}.md`].map((key) => key.toLowerCase());
	for (const key of directKeys) {
		const found = index.get(key);
		if (found) return found;
	}

	const possiblePaths = [resolve(dailyDir, target), resolve(root, target), resolve(root, `${cleanTarget}.md`)];
	for (const possible of possiblePaths) {
		const found = index.get(possible.toLowerCase()) || index.get(relative(root, possible).toLowerCase());
		if (found) return found;
	}

	return undefined;
}

function scoreNoteForTask(task: WorkItem, note: NoteDoc): { score: number; reason: string } {
	const terms = tokenize(task.text);
	let score = note.isProject ? 1 : 0;
	const matched: string[] = [];

	for (const term of terms) {
		const titleHit = note.title.toLowerCase().includes(term) || note.basename.toLowerCase().includes(term);
		const pathHit = note.relativePath.toLowerCase().includes(term);
		const contentHit = note.lower.includes(term);
		if (titleHit) score += 5;
		else if (pathHit) score += 3;
		else if (contentHit) score += 1;
		if (titleHit || pathHit || contentHit) matched.push(term);
	}

	// Keep hyphenated project/repo names strong, e.g. beh-pgdb.
	const phrases = Array.from(task.text.matchAll(/[A-Za-z0-9]+(?:[-_/][A-Za-z0-9]+)+/g)).map((m) => m[0].toLowerCase());
	for (const phrase of phrases) {
		if (note.lower.includes(phrase) || note.relativePath.toLowerCase().includes(phrase)) {
			score += 8;
			matched.push(phrase);
		}
	}

	return {
		score,
		reason: matched.length ? `matched ${Array.from(new Set(matched)).slice(0, 4).join(", ")}` : "project note",
	};
}

function dedupeRelated(notes: RelatedNote[], max: number): RelatedNote[] {
	const seen = new Set<string>();
	const deduped: RelatedNote[] = [];
	for (const note of notes.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))) {
		if (seen.has(note.path)) continue;
		seen.add(note.path);
		deduped.push(note);
		if (deduped.length >= max) break;
	}
	return deduped;
}

function makeInspiration(report: Omit<BrainTodosReport, "inspiration">): string {
	const name = (() => {
		try {
			return userInfo().username.replace(/^./, (c) => c.toUpperCase());
		} catch {
			return "You";
		}
	})();

	if (!report.dailyNotePath) {
		return `${name}, there may not be a daily note yet. Start gently: write one clear task, then let the next step reveal itself.`;
	}
	if (report.items.length === 0) {
		return `${name}, the list is quiet today. Protect that space: choose one small useful action, then let the rest stay light.`;
	}

	const first = stripMarkdown(report.items[0].item.text);
	const linked = report.items.filter((task) => task.related.length > 0).length;
	const unlinked = report.items.length - linked;
	const bridge = unlinked > 0 ? ` ${unlinked} item${unlinked === 1 ? "" : "s"} still need a home, and that is useful signal—not failure.` : " The project threads are visible enough to trust your next move.";

	return `${name}, keep the day narrow and humane: begin with “${first}.”${bridge} One clean pass is enough to create momentum.`;
}

async function buildReport(params: BrainTodosParamsType, signal?: AbortSignal): Promise<BrainTodosReport> {
	const date = params.date?.match(/^\d{4}-\d{2}-\d{2}$/) ? params.date : localDateString();
	const notesRoot = resolve(expandHome(params.notesRoot || "~/notes/brain-1"));
	const maxLinksPerTask = Math.max(1, Math.min(8, Math.floor(params.maxLinksPerTask || 3)));
	const warnings: string[] = [];

	if (!existsSync(notesRoot)) {
		const base = {
			date,
			notesRoot,
			items: [],
			allTasksCount: 0,
			openTasksCount: 0,
			searchedNotesCount: 0,
			warnings: [`Notes root not found: ${notesRoot}`],
		};
		return { ...base, inspiration: makeInspiration(base) };
	}

	const markdownFiles = await listMarkdownFiles(notesRoot, signal);
	const dailyNotePath = await findDailyNote(notesRoot, date, markdownFiles);
	if (!dailyNotePath) {
		const base = {
			date,
			notesRoot,
			items: [],
			allTasksCount: 0,
			openTasksCount: 0,
			searchedNotesCount: markdownFiles.length,
			warnings: [`Could not find today's daily note (${date}.md).`],
		};
		return { ...base, inspiration: makeInspiration(base) };
	}

	const dailyContent = await readFile(dailyNotePath, "utf8");
	const { selected, all } = extractWorkItems(dailyContent, params.includeCompleted === true);
	const dailyDir = dirname(dailyNotePath);

	const docs: NoteDoc[] = [];
	for (const file of markdownFiles) {
		if (file === dailyNotePath) continue;
		try {
			const content = await readFile(file, "utf8");
			const relativePath = relative(notesRoot, file);
			docs.push({
				path: file,
				relativePath,
				basename: basename(file, extname(file)),
				title: extractTitle(content, basename(file)),
				content,
				lower: content.toLowerCase(),
				isProject: relativePath.startsWith("Ψ/") || /tags:\s*[\s\S]*project/i.test(content),
			});
		} catch (error) {
			warnings.push(`Could not read ${relative(notesRoot, file)}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const noteIndex = buildNoteIndex(notesRoot, docs);
	const items: TaskReport[] = selected.map((item) => {
		const explicitTargets = [...extractWikiTargets(item.text), ...extractMarkdownLinkTargets(item.text)];
		const explicitNotes = explicitTargets
			.map((target) => resolveLinkedNote(target, notesRoot, dailyDir, noteIndex))
			.filter((note): note is NoteDoc => Boolean(note))
			.map((note) => ({
				title: note.title,
				path: note.path,
				relativePath: note.relativePath,
				score: 100,
				reason: "explicit link",
				explicit: true,
			}));

		const inferred = docs
			.map((note) => {
				const scored = scoreNoteForTask(item, note);
				return {
					title: note.title,
					path: note.path,
					relativePath: note.relativePath,
					score: scored.score,
					reason: scored.reason,
					explicit: false,
				};
			})
			.filter((note) => note.score >= 3);

		const related = dedupeRelated([...explicitNotes, ...inferred], maxLinksPerTask);
		return {
			item,
			related,
			missingLinkNote:
				related.length === 0
					? "I could not find a project or note connection for this one yet. Consider adding a [[Ψ project]] or note link when you know its home."
					: undefined,
		};
	});

	const base = {
		date,
		notesRoot,
		dailyNotePath,
		dailyNoteRelativePath: relative(notesRoot, dailyNotePath),
		items,
		allTasksCount: all.length,
		openTasksCount: all.filter((item) => !item.completed).length,
		searchedNotesCount: docs.length,
		warnings,
	};
	return { ...base, inspiration: makeInspiration(base) };
}

function reportToText(report: BrainTodosReport): string {
	const lines: string[] = [];
	lines.push(`Daily work items for ${report.date}`);
	if (report.dailyNoteRelativePath) lines.push(`Daily note: ${report.dailyNoteRelativePath}`);
	for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
	lines.push("");
	if (report.items.length === 0) {
		lines.push("No open work items found.");
	} else {
		for (const task of report.items) {
			lines.push(`- ${stripMarkdown(task.item.text)}`);
			if (task.related.length > 0) {
				for (const note of task.related) {
					lines.push(`  ↳ ${note.title} (${note.relativePath}) — ${note.reason}`);
				}
			} else if (task.missingLinkNote) {
				lines.push(`  ↳ ${task.missingLinkNote}`);
			}
		}
	}
	lines.push("");
	lines.push(report.inspiration);
	return lines.join("\n");
}

class BrainTodosCard {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private report: BrainTodosReport,
		private theme: Theme,
		private onClose?: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q" || matchesKey(data, "enter")) {
			this.onClose?.();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const theme = this.theme;
		const usable = Math.max(20, width);
		const lines: string[] = [];
		const add = (value = "") => lines.push(truncateToWidth(value, usable));
		const wrap = (value: string, indent = "") => {
			for (const line of wrapTextWithAnsi(value, Math.max(10, usable - indent.length))) {
				add(indent + line);
			}
		};
		const rule = (label?: string) => {
			if (!label) return add(theme.fg("borderMuted", "─".repeat(usable)));
			const left = "─── ";
			const right = " " + "─".repeat(Math.max(0, usable - left.length - label.length - 1));
			add(theme.fg("borderMuted", left) + theme.fg("accent", theme.bold(label)) + theme.fg("borderMuted", right));
		};

		rule(`Today · ${this.report.date}`);
		if (this.report.dailyNoteRelativePath) {
			add(` ${theme.fg("muted", "Daily note")} ${theme.fg("text", this.report.dailyNoteRelativePath)}`);
		}
		add(
			` ${theme.fg("muted", "Open")} ${theme.fg("accent", String(this.report.openTasksCount))}  ${theme.fg("muted", "Scanned notes")} ${theme.fg("accent", String(this.report.searchedNotesCount))}`,
		);
		if (this.report.warnings.length > 0) {
			for (const warning of this.report.warnings.slice(0, 3)) wrap(theme.fg("warning", ` ⚠ ${warning}`));
		}
		add();

		if (this.report.items.length === 0) {
			wrap(theme.fg("dim", "No open work items found in the daily note."), " ");
		} else {
			for (const task of this.report.items) {
				const check = task.item.completed ? theme.fg("success", "✓") : theme.fg("accent", "○");
				wrap(`${check} ${theme.fg("text", stripMarkdown(task.item.text))}`, " ");
				if (task.related.length > 0) {
					for (const note of task.related) {
						const linkType = note.explicit ? theme.fg("success", "linked") : theme.fg("muted", "inferred");
						wrap(
							`${theme.fg("dim", "↳")} ${theme.fg("accent", note.title)} ${theme.fg("dim", `(${note.relativePath})`)} ${linkType} · ${theme.fg("dim", note.reason)}`,
							"   ",
						);
					}
				} else if (task.missingLinkNote) {
					wrap(`${theme.fg("warning", "↳ no related note found")} ${theme.fg("dim", task.missingLinkNote)}`, "   ");
				}
				add();
			}
		}

		rule("Calm spark");
		wrap(theme.fg("success", this.report.inspiration), " ");
		add();
		if (this.onClose) add(theme.fg("dim", " Enter/q/Esc close"));
		rule();

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function parseCommandArgs(args: string): BrainTodosParamsType {
	const params: BrainTodosParamsType = {};
	const date = args.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
	if (date) params.date = date;
	const root = args.match(/--root(?:=|\s+)(\S+)/)?.[1];
	if (root) params.notesRoot = root;
	if (/--all\b/.test(args)) params.includeCompleted = true;
	return params;
}

function isBrainTodosRunPrompt(prompt: string | undefined): boolean {
	const lower = (prompt || "").toLowerCase().trim();
	if (!lower) return false;

	// Do not hijack coding requests about this extension's implementation.
	if (/\b(change|modify|edit|implement|fix|debug|work on|rework)\b/.test(lower) && /\btodos?\s+extension\b/.test(lower)) {
		return false;
	}

	if (/^\/?todos\b/.test(lower)) return true;
	if (/\bbrain[_ -]?todos\b/.test(lower)) return true;
	if (/\btodos?\s+extension\b/.test(lower) && /\b(run|show|open|display|use|validate|test)\b/.test(lower)) return true;
	if (/\b(today'?s|daily)\b/.test(lower) && /\b(work items?|todos?|tasks?)\b/.test(lower)) return true;
	return false;
}

export default function todosExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (!isBrainTodosRunPrompt(event.prompt)) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${BRAIN_TODOS_ONLY_RESPONSE_INSTRUCTION}`,
		};
	});

	pi.registerTool({
		name: "brain_todos",
		label: "Brain Todos",
		description:
			"Scan ~/notes/brain-1 for today's daily note, extract work items, infer links to project/other notes, and return a calm personalized inspiration message.",
		promptSnippet: "Scan today's second-brain daily todo note and infer relevant project/note links.",
		promptGuidelines: [
			"Use brain_todos when the user asks about today's work items, daily note todos, project links for tasks, or a short personalized inspiration message.",
			"When brain_todos satisfies the user's request, do not add any assistant follow-up, acknowledgement, summary, validation note, or extra prose after the tool result; the tool output is the complete answer.",
		],
		parameters: BrainTodosParams,

		async execute(_toolCallId, params: BrainTodosParamsType, signal) {
			const report = await buildReport(params, signal);
			return {
				content: [{ type: "text", text: reportToText(report) }],
				details: report,
			};
		},

		renderCall(args, theme) {
			const date = typeof args.date === "string" ? args.date : "today";
			return new BrainTodosCard(
				{
					date,
					notesRoot: "~/notes/brain-1",
					items: [],
					allTasksCount: 0,
					openTasksCount: 0,
					searchedNotesCount: 0,
					inspiration: "Scanning your daily note…",
					warnings: [],
				},
				theme,
			);
		},

		renderResult(result, _options, theme) {
			const report = result.details as BrainTodosReport | undefined;
			if (!report) return new BrainTodosCard({
				date: localDateString(),
				notesRoot: "~/notes/brain-1",
				items: [],
				allTasksCount: 0,
				openTasksCount: 0,
				searchedNotesCount: 0,
				inspiration: result.content?.[0]?.type === "text" ? result.content[0].text : "No report returned.",
				warnings: [],
			}, theme);
			return new BrainTodosCard(report, theme);
		},
	});

	pi.registerCommand("todos", {
		description: "Show today's second-brain work items, related notes, and a calm inspiration message",
		handler: async (args, ctx) => {
			const report = await buildReport(parseCommandArgs(args || ""));
			if (!ctx.hasUI) {
				ctx.ui.notify(reportToText(report), "info");
				return;
			}

			await ctx.ui.custom<void>(
				(_tui, theme, _keybindings, done) => new BrainTodosCard(report, theme, () => done()),
				{
					overlay: true,
					overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center", margin: 1 },
				},
			);
		},
	});
}
