const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appRoot = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");
const readAdhd = (name) => read(`public/js/adhd/${name}`);
// values created inside a vm context have that context's prototypes, which deepStrictEqual rejects
const plain = (value) => JSON.parse(JSON.stringify(value));

const escapeHtml = (value) =>
	String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

const translate = (text, values = []) =>
	values.reduce((result, value, index) => result.replace(`{${index}}`, value), text);

function makeStorage() {
	const data = new Map();
	return {
		data,
		getItem: (key) => (data.has(key) ? data.get(key) : null),
		setItem: (key, value) => data.set(key, String(value)),
		removeItem: (key) => data.delete(key),
	};
}

// A jQuery stand-in: every call answers with itself, and the calls that matter are recorded.
function makeChain(log = {}) {
	const proxy = new Proxy(
		{ length: 0 },
		{
			get(target, key) {
				if (key in target) return target[key];
				if (key === "prepend" || key === "html") {
					return (value) => {
						(log[key] ||= []).push(value);
						return proxy;
					};
				}
				return () => proxy;
			},
		}
	);
	return proxy;
}

function run(source, sandbox, filename) {
	vm.runInNewContext(source, sandbox, { filename });
	return sandbox;
}

// --- Smart Inbox ------------------------------------------------------------------------------------------

function loadSmartInbox({ user = "ann@example.com", modeOn = true } = {}) {
	const localStorage = makeStorage();
	const routes = [];
	const afterAjax = [];
	const log = {};
	function ScriptManager() {}
	ScriptManager.prototype.trigger = function () {};
	const sandbox = {
		console,
		localStorage,
		sessionStorage: makeStorage(),
		setTimeout: (fn) => fn(),
		setInterval: () => 1,
		clearInterval() {},
		$: () => makeChain(log),
		__: translate,
		frappe: {
			boot: { adhd_mode: modeOn },
			session: { user },
			provide() {},
			get_route: () => [],
			get_route_str: () => "",
			set_route: (...args) => routes.push(args),
			router: { on() {} },
			after_ajax: (fn) => afterAjax.push(fn),
			datetime: { get_today: () => "2026-09-21", prettyDate: (value) => String(value) },
			call: async () => ({ message: [] }),
			utils: { escape_html: escapeHtml },
			ui: { form: { ScriptManager } },
		},
		erpnext: { adhd: {} },
	};
	run(readAdhd("adhd_smart_inbox.js"), sandbox, "adhd_smart_inbox.js");
	return { sandbox, localStorage, routes, log, startUp: () => afterAjax.forEach((fn) => fn()) };
}

test("the post-login redirect opens the ADHD Inbox page by its route, not as a page named 'page'", () => {
	const { routes, startUp } = loadSmartInbox();
	startUp();
	assert.deepEqual(plain(routes), [["adhd-inbox"]]);
});

test("visiting a module is not recorded while ADHD mode is off", () => {
	const off = loadSmartInbox({ modeOn: false });
	off.sandbox.erpnext.adhd.smartInbox.recordVisit("Stock");
	assert.equal(off.localStorage.data.size, 0);

	const on = loadSmartInbox({ modeOn: true });
	on.sandbox.erpnext.adhd.smartInbox.recordVisit("Stock");
	assert.ok(on.localStorage.data.has("adhd_module_freq_ann@example.com"));
});

test("recent documents are stored and shown per user, and the old shared copy is removed", () => {
	const inbox = loadSmartInbox({ user: "ann@example.com" });
	inbox.localStorage.setItem("adhd_recent_docs", JSON.stringify([{ doctype: "ToDo", name: "OLD" }]));
	inbox.localStorage.setItem("adhd_resume_docs", JSON.stringify([{ doctype: "ToDo", docname: "OLD" }]));
	inbox.startUp();
	assert.equal(inbox.localStorage.data.has("adhd_recent_docs"), false);
	assert.equal(inbox.localStorage.data.has("adhd_resume_docs"), false);

	const { frappe } = inbox.sandbox;
	frappe.ui.form.ScriptManager.prototype.trigger.call(
		{ frm: { doctype: "Lead", doc: { name: "LEAD-1", title: "Ann's private deal" } } },
		"after_save"
	);
	assert.ok(inbox.localStorage.data.has("adhd_recent_docs_ann@example.com"));
	assert.ok(inbox.localStorage.data.has("adhd_resume_docs_ann@example.com"));
	assert.equal(inbox.localStorage.data.has("adhd_recent_docs"), false);

	// a second person on the same browser starts with nothing of Ann's
	frappe.session.user = "bob@example.com";
	inbox.log.html = [];
	inbox.sandbox.erpnext.adhd.smartInbox.refreshResumeItems();
	assert.match(inbox.log.html.at(-1), /Open any document to start tracking/);
});

test("module links use the /desk route, which the router handles without a page reload", async () => {
	const inbox = loadSmartInbox();
	const today = new Date().getDay();
	inbox.localStorage.setItem("adhd_module_freq_ann@example.com", JSON.stringify({ Stock: { [today]: 5 } }));
	inbox.sandbox.erpnext.adhd.renderSmartInbox({
		body: {},
		clear_inner_toolbar() {},
		set_primary_action() {},
	});
	await new Promise((resolve) => setImmediate(resolve));
	const markup = inbox.log.prepend.join("");
	assert.match(markup, /href="\/desk\/stock"/);
	assert.match(markup, /adhd-suggestion-banner/);
	assert.doesNotMatch(markup, /href="\/app\//);
});

// --- ADHD Inbox page --------------------------------------------------------------------------------------

function loadInboxPage({ modeOn }) {
	const calls = { made: 0, render: 0, refresh: 0, autoRefresh: 0, routes: [] };
	const sandbox = {
		__: translate,
		frappe: {
			boot: { adhd_mode: modeOn },
			pages: { "adhd-inbox": {} },
			set_route: (...args) => calls.routes.push(args),
			ui: {
				make_app_page: () => {
					calls.made += 1;
					return {};
				},
			},
		},
		erpnext: {
			adhd: {
				renderSmartInbox() {
					calls.render += 1;
				},
				smartInbox: {
					refresh() {
						calls.refresh += 1;
					},
					startAutoRefresh() {
						calls.autoRefresh += 1;
					},
				},
			},
		},
	};
	run(read("setup/page/adhd_inbox/adhd_inbox.js"), sandbox, "adhd_inbox.js");
	return { sandbox, calls, page: sandbox.frappe.pages["adhd-inbox"] };
}

test("the inbox page fetches once on the first visit, then refreshes on later visits", () => {
	const { page, calls } = loadInboxPage({ modeOn: true });
	page.on_page_load({});
	page.on_page_show();
	assert.equal(calls.render, 1);
	assert.equal(calls.refresh, 0);

	page.on_page_show();
	assert.equal(calls.render, 1);
	assert.equal(calls.refresh, 1);
	assert.equal(calls.autoRefresh, 1);
});

test("a first visit with ADHD mode off still builds the inbox once the mode is switched on", () => {
	const { sandbox, page, calls } = loadInboxPage({ modeOn: false });
	page.on_page_load({});
	page.on_page_show();
	assert.equal(calls.made, 1);
	assert.deepEqual(plain(calls.routes), [["Workspaces"]]);
	assert.equal(calls.render, 0);

	sandbox.frappe.boot.adhd_mode = true;
	page.on_page_show();
	assert.equal(calls.render, 1);
	assert.equal(calls.refresh, 0);
});

// --- Shortcut reference -----------------------------------------------------------------------------------

function loadHelp() {
	const listeners = {};
	const sandbox = {
		__: translate,
		document: {
			addEventListener: (type, fn) => (listeners[type] = fn),
			querySelector: () => null,
			body: {},
		},
		$: () => makeChain(),
		frappe: { provide() {}, boot: { adhd_mode: true }, utils: { escape_html: escapeHtml } },
		erpnext: { adhd: {} },
	};
	run(readAdhd("adhd_help.js"), sandbox, "adhd_help.js");
	return { sandbox, keydown: listeners.keydown };
}

const keyEvent = (props) => {
	const event = { defaultPrevented: false, ...props };
	event.preventDefault = () => (event.defaultPrevented = true);
	return event;
};

test("the shortcut reference lists only shortcuts that something handles", () => {
	const { sandbox } = loadHelp();
	const keys = plain(sandbox.erpnext.adhd.SHORTCUTS).map((shortcut) => shortcut.key);
	for (const removed of ["Alt+F", "Alt+N", "Alt+R", "Alt+←", "Alt+→", "Alt+?", "Ctrl+N", "Ctrl+A", "F5"]) {
		assert.equal(keys.includes(removed), false, removed);
	}
	for (const kept of ["Alt+A", "Alt+J", "Ctrl/Cmd+K", "Alt+Shift+/"]) {
		assert.ok(keys.includes(kept), kept);
	}
	assert.doesNotMatch(readAdhd("adhd_help.js"), /User Settings/);
});

test("the shortcut reference opens on macOS, where Option changes event.key, and not while typing", () => {
	const { sandbox, keydown } = loadHelp();
	const isHelp = sandbox.erpnext.adhd.isHelpShortcut;
	assert.equal(isHelp({ altKey: true, shiftKey: true, code: "Slash", key: "¿" }), true);
	assert.equal(isHelp({ altKey: true, shiftKey: true, code: "Slash", key: "?" }), true);
	assert.equal(isHelp({ altKey: false, shiftKey: true, code: "Slash", key: "?" }), false);
	assert.equal(isHelp({ altKey: true, shiftKey: false, code: "Slash", key: "/" }), false);
	assert.equal(isHelp({ altKey: true, metaKey: true, shiftKey: true, code: "Slash", key: "?" }), false);

	const mac = keyEvent({ altKey: true, shiftKey: true, code: "Slash", key: "¿", target: {} });
	keydown(mac);
	assert.equal(mac.defaultPrevented, true);

	sandbox.erpnext.adhd.isTypingTarget = () => true;
	const typing = keyEvent({ altKey: true, shiftKey: true, code: "Slash", key: "¿", target: {} });
	keydown(typing);
	assert.equal(typing.defaultPrevented, false);
});

// --- Mode toggle ------------------------------------------------------------------------------------------

function fakeTarget(tagName, { classes = [], editable = false } = {}) {
	return {
		tagName,
		isContentEditable: editable,
		closest(selector) {
			const parts = selector.split(",").map((part) => part.trim());
			const hit = parts.some((part) =>
				part.startsWith(".")
					? classes.includes(part.slice(1))
					: part.toLowerCase() === tagName.toLowerCase()
			);
			return hit ? this : null;
		},
	};
}

function loadMode() {
	const listeners = {};
	const afterAjax = [];
	const intervals = [];
	const cleared = [];
	const pageChange = [];
	const containers = {};
	const mounted = [];
	const document = {
		activeElement: null,
		addEventListener: (type, fn) => (listeners[type] = fn),
		body: { classList: { add() {}, remove() {} }, setAttribute() {} },
		querySelector: (selector) => containers[selector] || null,
		createElement: (tagName) => ({
			tagName: tagName.toUpperCase(),
			className: "",
			innerHTML: "",
			getClientRects: () => [{}],
		}),
		getElementById(id) {
			if (id !== "adhd-mode-toggle" || !mounted.length) return null;
			return {
				classList: { add() {}, remove() {} },
				setAttribute() {},
				addEventListener() {},
				closest: () => mounted[0],
			};
		},
	};
	const sandbox = {
		console,
		document,
		localStorage: makeStorage(),
		setInterval: (fn) => intervals.push(fn) && intervals.length,
		clearInterval: (id) => cleared.push(id),
		setTimeout,
		clearTimeout,
		$: (target) => ({
			on: (event, fn) => target === document && event === "page-change" && pageChange.push(fn),
		}),
		__: translate,
		window: {},
		frappe: {
			boot: {},
			session: { user: "ann@example.com" },
			provide() {},
			after_ajax: (fn) => afterAjax.push(fn),
			show_alert() {},
			ui: { form: { on() {} } },
		},
		erpnext: { adhd: {} },
	};
	run(readAdhd("adhd_mode.js"), sandbox, "adhd_mode.js");
	const rail = {
		tagName: "DIV",
		shown: true,
		getClientRects() {
			return this.shown ? [{}] : [];
		},
		appendChild(item) {
			mounted.push(item);
		},
	};
	return {
		sandbox,
		document,
		listeners,
		intervals,
		cleared,
		pageChange,
		mounted,
		rail,
		showRail: () => (containers[".dock-shortcuts"] = rail),
		startUp: () => afterAjax.forEach((fn) => fn()),
	};
}

test("Alt+A leaves rich-text editors alone but still toggles the mode elsewhere", () => {
	const mode = loadMode();
	const editors = [
		fakeTarget("DIV", { classes: ["ql-editor"] }),
		fakeTarget("DIV", { editable: true }),
		fakeTarget("TEXTAREA", { classes: ["ace_text-input"] }),
		fakeTarget("DIV", { classes: ["CodeMirror"] }),
	];
	for (const editor of editors) {
		mode.document.activeElement = editor;
		const event = keyEvent({ altKey: true, code: "KeyA", key: "å", target: editor });
		mode.listeners.keydown(event);
		assert.equal(event.defaultPrevented, false);
	}
	assert.notEqual(mode.sandbox.frappe.boot.adhd_mode, true);

	const page = fakeTarget("DIV");
	mode.document.activeElement = page;
	const event = keyEvent({ altKey: true, code: "KeyA", key: "å", target: page });
	mode.listeners.keydown(event);
	assert.equal(event.defaultPrevented, true);
	assert.equal(mode.sandbox.frappe.boot.adhd_mode, true);
});

test("the mode toggle is mounted where this Frappe's desk has room for it, then the polling stops", () => {
	const mode = loadMode();
	mode.startUp();
	assert.equal(mode.intervals.length, 1);

	// the rail is not built yet: keep trying
	mode.intervals[0]();
	assert.equal(mode.cleared.length, 0);
	assert.equal(mode.mounted.length, 0);

	mode.showRail();
	mode.intervals[0]();
	assert.equal(mode.mounted.length, 1);
	assert.equal(mode.mounted[0].className, "nav-item adhd-nav-item");
	assert.match(mode.mounted[0].innerHTML, /id="adhd-mode-toggle"/);
	assert.equal(mode.cleared.length, 1);

	// a page change does not add a second toggle
	mode.pageChange.forEach((fn) => fn());
	assert.equal(mode.mounted.length, 1);
});

test("the mode toggle polling is bounded when nothing to mount it in ever appears", () => {
	const mode = loadMode();
	mode.startUp();
	for (let attempt = 1; attempt < 40; attempt++) mode.intervals[0]();
	assert.equal(mode.cleared.length, 0);
	mode.intervals[0]();
	assert.equal(mode.cleared.length, 1);
});

// --- Telemetry --------------------------------------------------------------------------------------------

function loadTelemetry({ modeOn, frictionLogger }) {
	const calls = [];
	const fetches = [];
	const listeners = {};
	const state = { modeOn, frictionLogger };
	const sandbox = {
		URLSearchParams,
		setInterval: () => 1,
		fetch: (url, options) => {
			fetches.push({ url, options });
			return Promise.resolve();
		},
		window: {
			ADHDSettings: { get: (key) => key === "friction_logger" && state.frictionLogger },
			addEventListener: (type, fn) => (listeners[type] = fn),
		},
		frappe: {
			provide() {},
			csrf_token: "token",
			call: (args) => {
				calls.push(args);
				return Promise.resolve({});
			},
		},
		erpnext: { adhd: { isActive: () => state.modeOn } },
	};
	run(readAdhd("adhd_telemetry.js"), sandbox, "adhd_telemetry.js");
	return { telemetry: sandbox.window.ADHDTelemetry, calls, fetches, listeners, state };
}

test("telemetry queues nothing while ADHD mode is off, even with the friction logger on", () => {
	const { telemetry, state } = loadTelemetry({ modeOn: false, frictionLogger: true });
	telemetry.emit({ event_type: "form_save", doctype_name: "Lead" });
	assert.equal(telemetry._queue.length, 0);

	state.modeOn = true;
	telemetry.emit({ event_type: "form_save", doctype_name: "Lead" });
	assert.equal(telemetry._queue.length, 1);

	state.frictionLogger = false;
	telemetry.emit({ event_type: "form_save", doctype_name: "Lead" });
	assert.equal(telemetry._queue.length, 1);
});

test("telemetry sends the event fields and nothing else, and drops what was queued under an old choice", async () => {
	const { telemetry, calls, state } = loadTelemetry({ modeOn: true, frictionLogger: true });
	telemetry.emit({
		event_type: "command_intent",
		intent: "create_lead",
		typed: "call jo@acme.com",
		user: "ann@example.com",
	});
	await telemetry.flushQueue();
	assert.deepEqual(plain(calls.map((call) => call.args)), [
		{ event_type: "command_intent", intent: "create_lead" },
	]);

	telemetry.emit({ event_type: "form_save", doctype_name: "Lead" });
	state.modeOn = false;
	await telemetry.flushQueue();
	assert.equal(calls.length, 1);
	assert.equal(telemetry._queue.length, 0);
});

test("telemetry still flushes with keepalive when the page unloads, and only while it is enabled", () => {
	const on = loadTelemetry({ modeOn: true, frictionLogger: true });
	on.telemetry.emit({
		event_type: "wizard_skip",
		doctype_name: "Lead",
		field_name: "email",
		step_index: 2,
	});
	on.listeners.beforeunload();
	assert.equal(on.fetches.length, 1);
	assert.equal(on.fetches[0].options.keepalive, true);
	assert.equal(on.fetches[0].options.headers["X-Frappe-CSRF-Token"], "token");
	assert.equal(on.fetches[0].options.body.get("event_type"), "wizard_skip");
	assert.equal(on.fetches[0].options.body.get("step_index"), "2");

	const off = loadTelemetry({ modeOn: true, frictionLogger: true });
	off.telemetry.emit({ event_type: "wizard_skip" });
	off.state.modeOn = false;
	off.listeners.beforeunload();
	assert.equal(off.fetches.length, 0);
});

// --- Focus panel ------------------------------------------------------------------------------------------

function fakeElement(id) {
	return {
		id,
		textContent: "",
		innerHTML: "",
		value: "",
		checked: false,
		hidden: false,
		dataset: {},
		style: {},
		classList: { add() {}, remove() {}, contains: () => false },
		addEventListener() {},
		querySelectorAll: () => [],
		remove() {},
	};
}

function loadFocusPanel({ user = "ann@example.com" } = {}) {
	const elements = new Map();
	const appended = [];
	const stateCallbacks = [];
	const calls = [];
	const intervals = [];
	const cleared = [];
	const alerts = [];
	let presets = null;
	const document = {
		body: { appendChild: (element) => appended.push(element) },
		getElementById(id) {
			if (id === "adhd-focus-panel") return null;
			if (!elements.has(id)) elements.set(id, fakeElement(id));
			return elements.get(id);
		},
		createElement: () => fakeElement("created"),
		querySelector: () => null,
		// the presets come from the real template, so a preset missing its mode shows up here
		querySelectorAll(selector) {
			if (selector !== ".afp-preset") return [];
			presets ||= [
				...(appended[0]?.innerHTML || "").matchAll(/<button class="afp-preset"([^>]*)>/g),
			].map((match) => {
				const button = fakeElement("preset");
				for (const [, key, value] of match[1].matchAll(/data-(\w+)="([^"]*)"/g)) {
					button.dataset[key] = value;
				}
				button.addEventListener = (type, fn) => type === "click" && (button.click = fn);
				return button;
			});
			return presets;
		},
	};
	const sandbox = {
		console,
		document,
		Notification: { permission: "denied", requestPermission() {} },
		localStorage: makeStorage(),
		setInterval: (fn) => intervals.push(fn) && intervals.length,
		clearInterval: (id) => cleared.push(id),
		setTimeout,
		__: translate,
		window: {},
		frappe: {
			provide() {},
			session: { user },
			call: async (options) => {
				calls.push(options);
				return { message: [] };
			},
			show_alert: (options) => alerts.push(options),
			msgprint() {},
			datetime: { prettyDate: (value) => String(value) },
			utils: {
				escape_html: escapeHtml,
				get_form_link: (doctype, name) =>
					`/desk/${doctype.toLowerCase()}/${encodeURIComponent(name)}`,
			},
		},
		erpnext: {
			adhd: {
				isActive: () => true,
				onStateChange: (fn) => stateCallbacks.push(fn),
			},
		},
	};
	run(readAdhd("focus_panel.js"), sandbox, "focus_panel.js");
	const makePanel = () => new sandbox.erpnext.adhd.FocusPanel();
	return { sandbox, makePanel, document, elements, calls, intervals, cleared, alerts, stateCallbacks };
}

test("the 5m break preset starts a break, not a work session", () => {
	const { makePanel, document, elements } = loadFocusPanel();
	const panel = makePanel();
	const presets = document.querySelectorAll(".afp-preset");
	const byMinutes = (mins) => presets.find((button) => button.dataset.mins === mins);

	byMinutes("5").click();
	assert.equal(panel.timerMode, "break");
	assert.equal(panel.timerSeconds, 300);
	assert.equal(elements.get("afp-timer-label").textContent, "Break Time 🌱");

	byMinutes("50").click();
	assert.equal(panel.timerMode, "work");
	assert.equal(panel.timerSeconds, 3000);
	assert.equal(elements.get("afp-timer-label").textContent, "Work Session (50m)");
});

test("the ring counts down from the length of the session on screen", () => {
	const { makePanel, elements } = loadFocusPanel();
	const panel = makePanel();
	const circumference = 2 * Math.PI * 44;

	panel._timerReset(50 * 60, "work");
	panel.timerSeconds = 25 * 60;
	panel._updateTimerDisplay();
	assert.ok(Math.abs(elements.get("afp-ring-circle").style.strokeDashoffset - circumference / 2) < 1e-6);

	// a custom length, as timebox.startTimer(10) sets it, keeps the mode and fills the ring
	panel._timerReset(10 * 60);
	assert.equal(panel.timerMode, "work");
	panel._updateTimerDisplay();
	assert.equal(elements.get("afp-ring-circle").style.strokeDashoffset, 0);
});

test("a finished session reports its mode and minutes, and the next one starts in the other mode", () => {
	const { makePanel } = loadFocusPanel();
	const panel = makePanel();

	panel._timerReset(50 * 60, "work");
	assert.deepEqual(plain(panel._timerComplete()), { mode: "work", minutes: 50 });
	assert.deepEqual(plain(panel.lastTimerCompletion), { mode: "work", minutes: 50 });
	assert.equal(panel.timerMode, "break");
	assert.equal(panel.timerSeconds, 300);
	assert.equal(panel.timerTotalSeconds, 300);

	// the 5m break preset is logged as a break, and hands over to a work session
	panel._timerReset(5 * 60, "break");
	assert.deepEqual(plain(panel._timerComplete()), { mode: "break", minutes: 5 });
	assert.equal(panel.timerMode, "work");
	assert.equal(panel.timerSeconds, 25 * 60);
});

test("switching ADHD mode off stops a running timer", () => {
	const { stateCallbacks, cleared, sandbox } = loadFocusPanel();
	assert.equal(stateCallbacks.length, 1);
	stateCallbacks[0](true);
	const panel = sandbox.erpnext.adhd.focusPanel;
	panel._timerStart();
	assert.equal(panel.timerRunning, true);

	const clearedBefore = cleared.length;
	stateCallbacks[0](false);
	assert.equal(panel.timerRunning, false);
	assert.ok(cleared.length > clearedBefore);
	assert.equal(panel.timerSeconds, 25 * 60);
});

test("Your Tasks asks only for tasks assigned to the current user", async () => {
	const { makePanel, calls } = loadFocusPanel({ user: "ann@example.com" });
	makePanel();
	await new Promise((resolve) => setImmediate(resolve));
	const { args } = calls.find((call) => call.method === "frappe.client.get_list");
	assert.deepEqual(plain(args.filters), [
		["status", "in", ["Open", "Working", "Overdue"]],
		["_assign", "like", '%"ann@example.com"%'],
	]);
	assert.equal(args.limit_page_length, 20);
});

test("task subjects and projects are escaped, and links use the /desk route", () => {
	const { makePanel, elements } = loadFocusPanel();
	const panel = makePanel();
	panel._renderTasks([
		{
			name: "TASK-1",
			subject: "<img src=x onerror=alert(1)>",
			project: "<b>Big</b> & Co",
			status: "Open",
			priority: "High",
		},
	]);
	const html = elements.get("afp-task-list").innerHTML;
	assert.doesNotMatch(html, /<img/);
	assert.doesNotMatch(html, /<b>Big/);
	assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
	assert.match(html, /&lt;b&gt;Big&lt;\/b&gt; &amp; Co/);
	assert.match(html, /href="\/desk\/task\/TASK-1"/);
	assert.doesNotMatch(html, /\/app\//);
});
