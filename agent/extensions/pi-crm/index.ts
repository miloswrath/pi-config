/**
 * pi-crm - Obsidian CRM intake/update/prep workflow
 *
 * Stores contact notes under /home/zak/notes/brain-1/Δ/crm.
 */

import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const CRM_DIR = "/home/zak/notes/brain-1/Δ/crm";
const STATUS_VALUES = ["hot", "warm", "cold", "dormant"] as const;
const IMPORTANCE_VALUES = ["high", "medium", "low"] as const;

type Answer = { id: string; value: string; label: string; wasCustom: boolean; index?: number };
type QuestionOption = { value: string; label: string; description?: string };
type Question = {
	id: string;
	label?: string;
	prompt: string;
	options: QuestionOption[];
	allowOther?: boolean;
};

type Frontmatter = Record<string, string>;

type ContactCandidate = {
	path: string;
	filename: string;
	name: string;
	frontmatter: Frontmatter;
	content: string;
};

const NameParams = Type.Object({
	name: Type.String({ description: "Contact display name or search query" }),
});

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function yamlString(value: string): string {
	return JSON.stringify(value ?? "");
}

function parseYamlString(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function renderFrontmatter(fm: Frontmatter): string {
	const ordered = ["name", "relationship", "status", "organization", "importance", "email", "role", "created", "updated"];
	const keys = [...ordered, ...Object.keys(fm).filter((k) => !ordered.includes(k))];
	const lines = keys.map((key) => `${key}: ${yamlString(fm[key] ?? "")}`);
	return `---\n${lines.join("\n")}\n---\n`;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return { frontmatter: {}, body: content };
	const fm: Frontmatter = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1);
		if (key) fm[key] = parseYamlString(value);
	}
	return { frontmatter: fm, body: content.slice(match[0].length) };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionBounds(content: string, title: string): { start: number; bodyStart: number; end: number } | null {
	const heading = new RegExp(`^## ${escapeRegExp(title)}\\s*$`, "m");
	const match = heading.exec(content);
	if (!match || match.index === undefined) return null;
	const start = match.index;
	const bodyStart = start + match[0].length;
	const afterHeading = content.slice(bodyStart);
	const next = afterHeading.search(/^##\s+/m);
	const end = next === -1 ? content.length : bodyStart + next;
	return { start, bodyStart, end };
}

function getSection(content: string, title: string): string {
	const bounds = sectionBounds(content, title);
	if (!bounds) return "";
	return content.slice(bounds.bodyStart, bounds.end).trim();
}

function replaceSection(content: string, title: string, body: string): string {
	const section = `## ${title}\n${body.trim()}\n`;
	const bounds = sectionBounds(content, title);
	if (bounds) {
		return `${content.slice(0, bounds.start)}${section}${content.slice(bounds.end)}`;
	}
	return `${content.trim()}\n\n${section}`;
}

function appendToSection(content: string, title: string, addition: string): string {
	const current = getSection(content, title);
	const cleanCurrent = current.replace(/^_No .* yet\._$/m, "").trim();
	const next = [cleanCurrent, addition.trim()].filter(Boolean).join("\n\n");
	return replaceSection(content, title, next || `_No ${title.toLowerCase()} yet._`);
}

function slugify(name: string): string {
	const slug = name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "contact";
}

function normalizeSearch(value: string): string {
	return slugify(value).replace(/-/g, " ").trim();
}

function cleanInput(value: string | undefined): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed || trimmed === "(no response)" || trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "unknown") {
		return "";
	}
	return trimmed;
}

function stripBullet(line: string): string {
	return line.replace(/^\s*[-*]\s*/, "").trim();
}

function datedBullets(text: string, date: string, fallback: string): string {
	const lines = cleanInput(text)
		.split("\n")
		.map(stripBullet)
		.filter(Boolean);
	if (lines.length === 0) return `- [${date}] ${fallback}`;
	return lines.map((line) => `- [${date}] ${line}`).join("\n");
}

const TIDY_INFO_SYSTEM_PROMPT = `You tidy rough CRM note input into readable Obsidian-ready note lines.

Rules:
- Preserve the user's facts, names, uncertainty, tone, and meaning.
- Do not add facts, assumptions, dates, labels, or follow-up advice.
- Fix obvious typos and grammar.
- Split unrelated ideas into separate short lines.
- Output plain text only: no markdown bullets, numbering, headings, quotes, or code fences.
- The CRM tool will add date bullets later, so do not include dates unless the user explicitly provided a meaningful date.`;

function cleanTidiedInfo(value: string): string {
	return cleanInput(value)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("```") && !line.endsWith("```"))
		.map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))
		.map((line) => line.replace(/^\[(\d{4}-\d{2}-\d{2})\]\s*/, ""))
		.map((line) => line.trim())
		.filter(Boolean)
		.join("\n");
}

async function tidyInfoText(ctx: ExtensionContext, text: string, section: "crystallized" | "recent", signal?: AbortSignal): Promise<string> {
	const cleaned = cleanInput(text);
	if (!cleaned || !ctx.model) return cleaned;

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) return cleaned;

		const userMessage: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: [`Section: ${section === "crystallized" ? "Crystallized stable information" : "Recent timely information"}`, "", "Input:", cleaned].join("\n"),
				},
			],
			timestamp: Date.now(),
		};

		const response = await complete(
			ctx.model,
			{ systemPrompt: TIDY_INFO_SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal },
		);
		if (response.stopReason === "aborted") return cleaned;

		const tidied = cleanTidiedInfo(
			response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n"),
		);
		return tidied || cleaned;
	} catch {
		return cleaned;
	}
}

async function tidyCrmInfo(ctx: ExtensionContext, answers: Map<string, Answer>, signal?: AbortSignal) {
	const crystallized = answer(answers, "crystallized");
	const recent = answer(answers, "recent");
	if ((cleanInput(crystallized) || cleanInput(recent)) && ctx.hasUI) ctx.ui.notify("Tidying CRM notes with the current model...", "info");
	const [tidiedCrystallized, tidiedRecent] = await Promise.all([
		tidyInfoText(ctx, crystallized, "crystallized", signal),
		tidyInfoText(ctx, recent, "recent", signal),
	]);
	return { crystallized: tidiedCrystallized, recent: tidiedRecent };
}

function oneLine(value: string | undefined, fallback = "unknown"): string {
	const cleaned = cleanInput(value);
	return cleaned || fallback;
}

function metadataSummary(fm: Frontmatter): string {
	return [
		`relationship: ${oneLine(fm.relationship)}`,
		`status: ${oneLine(fm.status)}`,
		`organization: ${oneLine(fm.organization)}`,
		`importance: ${oneLine(fm.importance)}`,
		`email: ${oneLine(fm.email)}`,
		`role: ${oneLine(fm.role)}`,
	].join("; ");
}

function buildContactMarkdown(fm: Frontmatter, crystallized: string, recent: string, extras: string, date: string): string {
	const profile = [
		`- [${date}] Created CRM profile for ${fm.name}.`,
		`- [${date}] ${metadataSummary(fm)}.`,
	].join("\n");

	return `${renderFrontmatter(fm)}\n# ${fm.name}\n\n## Profile\n${profile}\n\n## Crystallized Information\n${datedBullets(
		crystallized,
		date,
		"No crystallized information recorded yet.",
	)}\n\n## Recent Information\n${datedBullets(recent, date, "No recent information recorded yet.")}\n\n## Recent History\n_No archived recent information yet._\n\n## Extras\n${datedBullets(extras, date, "No extras recorded yet.")}\n\n## Prep Log\n_No prep logs yet._\n`;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
	await mkdir(dir, { recursive: true });
	const out: string[] = [];
	async function walk(current: string) {
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
		}
	}
	await walk(dir);
	return out.sort();
}

async function readContact(path: string): Promise<ContactCandidate> {
	const content = await readFile(path, "utf8");
	const { frontmatter, body } = parseFrontmatter(content);
	const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	const filename = basename(path);
	const name = frontmatter.name || heading || filename.replace(/\.md$/, "");
	return { path, filename, name, frontmatter, content };
}

async function findContacts(query: string): Promise<ContactCandidate[]> {
	const files = await listMarkdownFiles(CRM_DIR);
	const contacts = await Promise.all(files.map(readContact));
	const q = normalizeSearch(query);
	const qTokens = q.split(/\s+/).filter(Boolean);
	const scored = contacts
		.map((c) => {
			const haystack = normalizeSearch(
				[
					c.name,
					c.filename.replace(/\.md$/, ""),
					c.frontmatter.organization,
					c.frontmatter.email,
					c.frontmatter.role,
				]
					.filter(Boolean)
					.join(" "),
			);
			let score = 0;
			if (haystack === q) score += 100;
			if (haystack.includes(q)) score += 50;
			for (const token of qTokens) if (haystack.includes(token)) score += 10;
			return { contact: c, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.contact.path.localeCompare(b.contact.path));
	return scored.map((x) => x.contact);
}

async function askQuestions(ctx: ExtensionContext, title: string, questionsIn: Question[]): Promise<Map<string, Answer> | null> {
	if (!ctx.hasUI) return null;
	const questions = questionsIn.map((q, i) => ({ ...q, label: q.label || `Q${i + 1}`, allowOther: q.allowOther !== false }));
	const result = await ctx.ui.custom<{ answers: Answer[]; cancelled: boolean }>((tui, theme, _kb, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, Answer>();
		const totalTabs = questions.length + 1;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}
		function submit(cancelled: boolean) {
			done({ answers: Array.from(answers.values()), cancelled });
		}
		function q() {
			return questions[currentTab];
		}
		function opts() {
			const current = q();
			if (!current) return [] as (QuestionOption & { isOther?: boolean })[];
			const all = [...current.options] as (QuestionOption & { isOther?: boolean })[];
			if (current.allowOther) all.push({ value: "__other__", label: "Type something.", isOther: true });
			return all;
		}
		function allAnswered() {
			return questions.every((question) => answers.has(question.id));
		}
		function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
			answers.set(questionId, { id: questionId, value, label, wasCustom, index });
		}
		function advance() {
			if (currentTab < questions.length - 1) currentTab++;
			else currentTab = questions.length;
			optionIndex = 0;
			refresh();
		}

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim() || "(no response)";
			saveAnswer(inputQuestionId, trimmed, trimmed, true);
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			advance();
		};

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				currentTab = (currentTab + 1) % totalTabs;
				optionIndex = 0;
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				currentTab = (currentTab - 1 + totalTabs) % totalTabs;
				optionIndex = 0;
				refresh();
				return;
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
				else if (matchesKey(data, Key.escape)) submit(true);
				return;
			}

			const currentOpts = opts();
			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(currentOpts.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const current = q();
				const selected = currentOpts[optionIndex];
				if (!current || !selected) return;
				if (selected.isOther) {
					inputMode = true;
					inputQuestionId = current.id;
					editor.setText("");
					refresh();
					return;
				}
				saveAnswer(current.id, selected.value, selected.label, false, optionIndex + 1);
				advance();
				return;
			}
			if (matchesKey(data, Key.escape)) submit(true);
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));
			const current = q();
			const currentOpts = opts();
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("toolTitle", theme.bold(` ${title}`)));
			const tabs: string[] = ["← "];
			for (let i = 0; i < questions.length; i++) {
				const active = i === currentTab;
				const answered = answers.has(questions[i].id);
				const marker = answered ? "■" : "□";
				const text = ` ${marker} ${questions[i].label} `;
				tabs.push(active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text));
			}
			const submitText = " ✓ Submit ";
			tabs.push(
				currentTab === questions.length
					? theme.bg("selectedBg", theme.fg("text", submitText))
					: theme.fg(allAnswered() ? "success" : "dim", submitText),
			);
			add(` ${tabs.join(" ")} →`);
			lines.push("");

			function renderOptions() {
				for (let i = 0; i < currentOpts.length; i++) {
					const opt = currentOpts[i];
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const suffix = opt.isOther && inputMode ? " ✎" : "";
					add(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}${suffix}`));
					if (opt.description) add(`     ${theme.fg("muted", opt.description)}`);
				}
			}

			if (inputMode && current) {
				add(theme.fg("text", ` ${current.prompt}`));
				lines.push("");
				renderOptions();
				lines.push("");
				add(theme.fg("muted", " Your answer:"));
				for (const line of editor.render(width - 2)) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to cancel typing"));
			} else if (currentTab === questions.length) {
				add(theme.fg("accent", theme.bold(" Ready to submit")));
				lines.push("");
				for (const question of questions) {
					const answer = answers.get(question.id);
					if (answer) add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", answer.label)}`);
				}
				lines.push("");
				add(allAnswered() ? theme.fg("success", " Press Enter to submit") : theme.fg("warning", " Answer all tabs before submitting"));
			} else if (current) {
				add(theme.fg("text", ` ${current.prompt}`));
				lines.push("");
				renderOptions();
				lines.push("");
				add(theme.fg("dim", " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"));
			}
			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			return lines;
		}

		return { render, invalidate: () => (cachedLines = undefined), handleInput };
	});
	if (!result || result.cancelled) return null;
	return new Map(result.answers.map((answer) => [answer.id, answer]));
}

function answer(answers: Map<string, Answer>, id: string): string {
	return answers.get(id)?.value ?? "";
}

function fixedOptions(values: readonly string[], current?: string): QuestionOption[] {
	const opts = values.map((value) => ({ value, label: value }));
	if (current !== undefined) return [{ value: "__keep__", label: `Keep current (${current || "blank"})` }, ...opts];
	return opts;
}

function textUpdateOptions(current: string | undefined): QuestionOption[] {
	return [
		{ value: "__keep__", label: `Keep current (${current || "blank"})` },
		{ value: "", label: "Clear / unknown" },
	];
}

function valueOrKeep(value: string, current: string | undefined): string {
	if (value === "__keep__") return current ?? "";
	return cleanInput(value);
}

async function pickContact(ctx: ExtensionContext, query: string): Promise<ContactCandidate | null> {
	const candidates = await findContacts(query);
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0];

	const choices = candidates.slice(0, 20).map((c) => ({
		value: c.path,
		label: c.name,
		description: `${c.path} — ${metadataSummary(c.frontmatter)}`,
	}));
	const selected = await askQuestions(ctx, "CRM: confirm matching contact", [
		{
			id: "path",
			label: "Contact",
			prompt: `Multiple CRM contacts matched “${query}”. Select the correct person.`,
			options: choices,
			allowOther: false,
		},
	]);
	if (!selected) return null;
	const selectedPath = answer(selected, "path");
	return candidates.find((c) => c.path === selectedPath) ?? null;
}

function resultText(mode: string, path: string, message: string): string {
	return `Mode: ${mode}\nPath: ${path}\n${message}`;
}

async function runNewContact(ctx: ExtensionContext, name: string, signal?: AbortSignal) {
	const date = today();
	const slug = slugify(name);
	const path = join(CRM_DIR, `${slug}.md`);
	const answers = await askQuestions(ctx, "CRM NEW intake", [
		{
			id: "relationship",
			label: "Relation",
			prompt: `NEW contact: ${name}\nPath: ${path}\nRelationship to you?`,
			options: ["coworker", "friend", "mentor", "recruiter", "founder", "investor", "classmate", "family"].map((v) => ({ value: v, label: v })),
			allowOther: true,
		},
		{ id: "status", label: "Status", prompt: "Relationship temperature/status?", options: fixedOptions(STATUS_VALUES), allowOther: false },
		{ id: "importance", label: "Importance", prompt: "Importance?", options: fixedOptions(IMPORTANCE_VALUES), allowOther: false },
		{ id: "organization", label: "Org", prompt: "Organization?", options: [{ value: "", label: "Unknown / none" }], allowOther: true },
		{ id: "email", label: "Email", prompt: "Email?", options: [{ value: "", label: "Unknown / none" }], allowOther: true },
		{ id: "role", label: "Role", prompt: "Role/title?", options: [{ value: "", label: "Unknown / none" }], allowOther: true },
		{ id: "crystallized", label: "Stable", prompt: "Crystallized/stable information to remember?", options: [{ value: "", label: "Nothing yet" }], allowOther: true },
		{ id: "recent", label: "Recent", prompt: "Most recent/timely information?", options: [{ value: "", label: "Nothing recent" }], allowOther: true },
		{ id: "extras", label: "Extras", prompt: "Extras?", options: [{ value: "", label: "No extras" }], allowOther: true },
	]);
	if (!answers) return { content: [{ type: "text" as const, text: resultText("NEW", path, "Cancelled CRM intake.") }], details: { mode: "NEW", path, cancelled: true } };

	const tidied = await tidyCrmInfo(ctx, answers, signal);

	const fm: Frontmatter = {
		name,
		relationship: cleanInput(answer(answers, "relationship")),
		status: answer(answers, "status"),
		organization: cleanInput(answer(answers, "organization")),
		importance: answer(answers, "importance"),
		email: cleanInput(answer(answers, "email")),
		role: cleanInput(answer(answers, "role")),
		created: date,
		updated: date,
	};

	return withFileMutationQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		if (await pathExists(path)) {
			return {
				content: [
					{
						type: "text" as const,
						text: resultText("NEW", path, "A contact file already exists at this path. Use crm_update_contact instead."),
					},
				],
				details: { mode: "NEW", path, exists: true },
			};
		}
		const markdown = buildContactMarkdown(fm, tidied.crystallized, tidied.recent, answer(answers, "extras"), date);
		await writeFile(path, markdown, "utf8");
		return {
			content: [{ type: "text" as const, text: resultText("NEW", path, `Created CRM contact for ${name}.`) }],
			details: { mode: "NEW", path, frontmatter: fm },
		};
	});
}

async function runUpdateContact(ctx: ExtensionContext, query: string, signal?: AbortSignal) {
	const date = today();
	const contact = await pickContact(ctx, query);
	if (!contact) {
		return { content: [{ type: "text" as const, text: resultText("UPDATE", CRM_DIR, `No contact found for “${query}”.`) }], details: { mode: "UPDATE", found: false } };
	}
	const current = contact.frontmatter;
	const answers = await askQuestions(ctx, "CRM UPDATE intake", [
		{
			id: "relationship",
			label: "Relation",
			prompt: `UPDATE contact: ${contact.name}\nPath: ${contact.path}\nUpdate relationship?`,
			options: textUpdateOptions(current.relationship),
			allowOther: true,
		},
		{ id: "status", label: "Status", prompt: "Update relationship temperature/status?", options: fixedOptions(STATUS_VALUES, current.status), allowOther: false },
		{ id: "importance", label: "Importance", prompt: "Update importance?", options: fixedOptions(IMPORTANCE_VALUES, current.importance), allowOther: false },
		{ id: "organization", label: "Org", prompt: "Update organization?", options: textUpdateOptions(current.organization), allowOther: true },
		{ id: "email", label: "Email", prompt: "Update email?", options: textUpdateOptions(current.email), allowOther: true },
		{ id: "role", label: "Role", prompt: "Update role/title?", options: textUpdateOptions(current.role), allowOther: true },
		{ id: "recent", label: "Recent", prompt: "New most recent/timely information? This replaces the current Recent Information section after archiving it.", options: [{ value: "", label: "No new recent info" }], allowOther: true },
		{ id: "crystallized", label: "Stable", prompt: "New crystallized/stable facts to append?", options: [{ value: "", label: "No new stable facts" }], allowOther: true },
		{ id: "extras", label: "Extras", prompt: "New extras to append?", options: [{ value: "", label: "No new extras" }], allowOther: true },
	]);
	if (!answers) return { content: [{ type: "text" as const, text: resultText("UPDATE", contact.path, "Cancelled CRM update.") }], details: { mode: "UPDATE", path: contact.path, cancelled: true } };

	const tidied = await tidyCrmInfo(ctx, answers, signal);

	return withFileMutationQueue(contact.path, async () => {
		const latest = await readFile(contact.path, "utf8");
		const parsed = parseFrontmatter(latest);
		const fm: Frontmatter = {
			...parsed.frontmatter,
			name: parsed.frontmatter.name || contact.name,
			relationship: valueOrKeep(answer(answers, "relationship"), parsed.frontmatter.relationship),
			status: valueOrKeep(answer(answers, "status"), parsed.frontmatter.status),
			organization: valueOrKeep(answer(answers, "organization"), parsed.frontmatter.organization),
			importance: valueOrKeep(answer(answers, "importance"), parsed.frontmatter.importance),
			email: valueOrKeep(answer(answers, "email"), parsed.frontmatter.email),
			role: valueOrKeep(answer(answers, "role"), parsed.frontmatter.role),
			created: parsed.frontmatter.created || date,
			updated: date,
		};

		let body = parsed.body.trim();
		if (!body.startsWith("#")) body = `# ${fm.name}\n\n${body}`;

		const profileAddition = `- [${date}] Updated CRM profile: ${metadataSummary(fm)}.`;
		body = appendToSection(body, "Profile", profileAddition);

		const oldRecent = getSection(body, "Recent Information").trim();
		if (oldRecent && !oldRecent.startsWith("_No ")) {
			const archive = `### Archived ${date}\n${oldRecent}`;
			const currentHistory = getSection(body, "Recent History").replace(/^_No .* yet\._$/m, "").trim();
			body = replaceSection(body, "Recent History", [archive, currentHistory].filter(Boolean).join("\n\n"));
		}

		body = replaceSection(body, "Recent Information", datedBullets(tidied.recent, date, "No new recent information recorded."));

		const crystallized = cleanInput(tidied.crystallized);
		if (crystallized) body = appendToSection(body, "Crystallized Information", datedBullets(crystallized, date, ""));

		const extras = cleanInput(answer(answers, "extras"));
		if (extras) body = appendToSection(body, "Extras", datedBullets(extras, date, ""));

		const markdown = `${renderFrontmatter(fm)}\n${body.trim()}\n`;
		await writeFile(contact.path, markdown, "utf8");
		return {
			content: [{ type: "text" as const, text: resultText("UPDATE", contact.path, `Updated CRM contact for ${fm.name}. Archived old recent info and replaced Recent Information.`) }],
			details: { mode: "UPDATE", path: contact.path, frontmatter: fm },
		};
	});
}

function firstDatedEntry(section: string): { date: string; text: string } | null {
	const match = section.match(/[-*]\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)/);
	if (!match) return null;
	return { date: match[1], text: match[2].trim() };
}

function buildPrep(contact: ContactCandidate, date: string): string {
	const { frontmatter: fm, body } = parseFrontmatter(contact.content);
	const profile = getSection(body, "Profile");
	const crystallized = getSection(body, "Crystallized Information");
	const recent = getSection(body, "Recent Information");
	const history = getSection(body, "Recent History");
	const extras = getSection(body, "Extras");
	const mostRecent = firstDatedEntry(recent);
	const starterTopic = mostRecent?.text.replace(/[.!?]$/, "") || `your work${fm.organization ? ` at ${fm.organization}` : ""}`;
	const orgRole = [fm.role, fm.organization].filter(Boolean).join(" at ") || "what you are focused on";

	return `# CRM Prep: ${fm.name || contact.name}\n\nMode: PREP\nPath: ${contact.path}\nPrep date: ${date}\nContact updated: ${fm.updated || "unknown"}\n\n## Overall Profile\n- [${fm.updated || fm.created || date}] ${metadataSummary(fm)}.\n\n${profile ? `## Profile Notes\n${profile}\n\n` : ""}## Most Recent Information\n${recent || `- [${date}] No recent information recorded.`}\n\n## Crystallized Information\n${crystallized || `- [${date}] No crystallized information recorded.`}\n\n${extras ? `## Extras\n${extras}\n\n` : ""}${history ? `## Recent History\n${history}\n\n` : ""}## Potential Conversation Starters\n### Informal\n- Ask how “${starterTopic}” has been going. (${mostRecent?.date || date})\n- Mention something from the latest CRM note and ask what has changed since then. (${mostRecent?.date || date})\n\n### Formal\n- Ask what priorities are most important in ${orgRole} right now. (${date})\n- Ask whether there is anything useful you can share, introduce, or follow up on given the latest context. (${date})\n`;
}

async function runPrepContact(ctx: ExtensionContext, query: string) {
	const date = today();
	const contact = await pickContact(ctx, query);
	if (!contact) {
		return { content: [{ type: "text" as const, text: resultText("PREP", CRM_DIR, `No contact found for “${query}”.`) }], details: { mode: "PREP", found: false } };
	}
	const fresh = await readContact(contact.path);
	const prep = buildPrep(fresh, date);
	const save = await askQuestions(ctx, "CRM PREP save?", [
		{
			id: "save",
			label: "Save",
			prompt: `PREP contact: ${fresh.name}\nPath: ${fresh.path}\nSave this prep to the contact note's Prep Log?`,
			options: [
				{ value: "no", label: "Display only" },
				{ value: "yes", label: "Save to Prep Log" },
			],
			allowOther: false,
		},
	]);
	let saved = false;
	if (save && answer(save, "save") === "yes") {
		await withFileMutationQueue(fresh.path, async () => {
			const latest = await readFile(fresh.path, "utf8");
			const parsed = parseFrontmatter(latest);
			const entry = `### ${date} Prep\n${prep}`;
			const body = appendToSection(parsed.body.trim(), "Prep Log", entry);
			const fm = { ...parsed.frontmatter, updated: parsed.frontmatter.updated || date };
			await writeFile(fresh.path, `${renderFrontmatter(fm)}\n${body.trim()}\n`, "utf8");
		});
		saved = true;
	}
	return {
		content: [{ type: "text" as const, text: `${prep}\n\nSaved to Prep Log: ${saved ? "yes" : "no"}` }],
		details: { mode: "PREP", path: fresh.path, saved },
	};
}

export default function piCrm(pi: ExtensionAPI) {
	pi.registerTool({
		name: "crm_new_contact",
		label: "CRM New Contact",
		description: "Create a new Obsidian CRM contact note by name. Infers NEW mode from user context, opens an intake questionnaire UI, tidies crystallized/recent free-text with the current model, uses today's date for every entry, writes to /home/zak/notes/brain-1/Δ/crm/<slug>.md, and displays mode/path transparently.",
		promptSnippet: "Create a new dated Obsidian CRM contact note after interactive CRM intake",
		promptGuidelines: [
			"Use crm_new_contact when the user asks to add, create, or intake a new CRM contact.",
			"Do not use crm_new_contact to modify an existing contact; use crm_update_contact instead.",
		],
		parameters: NameParams,
		execute: async (_id, params, signal, _onUpdate, ctx) => runNewContact(ctx, params.name, signal),
		renderCall(args, theme) {
			const name = typeof args.name === "string" ? args.name : "";
			const path = join(CRM_DIR, `${slugify(name)}.md`);
			return new Text(theme.fg("toolTitle", theme.bold("crm NEW ")) + theme.fg("muted", `${name} → ${path}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { path?: string; cancelled?: boolean; exists?: boolean } | undefined;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const color = details?.cancelled || details?.exists ? "warning" : "success";
			return new Text(theme.fg(color, text), 0, 0);
		},
	});

	pi.registerTool({
		name: "crm_update_contact",
		label: "CRM Update Contact",
		description: "Search for an existing Obsidian CRM contact by name, confirm the correct person if multiple match, open an update questionnaire UI, tidy crystallized/recent free-text with the current model, archive old Recent Information into Recent History, replace Recent Information with dated new info, and display UPDATE mode/path transparently.",
		promptSnippet: "Update an existing dated Obsidian CRM contact note after interactive CRM intake",
		promptGuidelines: [
			"Use crm_update_contact when the user asks to update, add newly learned facts, or record a recent interaction for an existing CRM contact.",
			"Use crm_update_contact rather than direct file edits for CRM updates so old recent info is archived correctly.",
		],
		parameters: NameParams,
		execute: async (_id, params, signal, _onUpdate, ctx) => runUpdateContact(ctx, params.name, signal),
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("crm UPDATE ")) + theme.fg("muted", String(args.name ?? "")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(theme.fg("success", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "crm_prep_contact",
		label: "CRM Prep Contact",
		description: "Search for an existing Obsidian CRM contact by name, confirm if multiple match, return a dated prep overview emphasizing most recent information with conversation starters, and ask whether to save to the contact Prep Log.",
		promptSnippet: "Prepare for a conversation with a CRM contact using dated CRM context",
		promptGuidelines: ["Use crm_prep_contact when the user asks to prep for, brief on, summarize, or get conversation starters for a CRM contact."],
		parameters: NameParams,
		execute: async (_id, params, _signal, _onUpdate, ctx) => runPrepContact(ctx, params.name),
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("crm PREP ")) + theme.fg("muted", String(args.name ?? "")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { path?: string; saved?: boolean } | undefined;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(theme.fg("success", text) + (details?.saved ? "" : ""), 0, 0);
		},
	});
}
