// Regression tests for the follow-up review fixes: the timer-complete event detail, the "Done Well" submit
// hook, the Purchase Order steps, the Opportunity stage bar and the notification snooze checker.
// Each assertion is written to fail against the code as it was before the fixes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const jsRoot = path.resolve(__dirname, "../public/js/adhd");
const readAdhd = (name) => fs.readFileSync(path.join(jsRoot, name), "utf8");
// values created inside a vm context have that context's prototypes, which deepStrictEqual rejects
const plain = (value) => JSON.parse(JSON.stringify(value));
const translate = (text, values = []) =>
	values.reduce((result, value, index) => result.replace(`{${index}}`, value), text);

// Any jQuery-style call returns the same empty collection.
function makeChain() {
	const chain = new Proxy(function () {}, {
		get: (_target, key) => (key === "length" ? 0 : () => chain),
	});
	return chain;
}

function makeStorage() {
	const data = new Map();
	return {
		getItem: (key) => (data.has(key) ? data.get(key) : null),
		setItem: (key, value) => data.set(key, String(value)),
		removeItem: (key) => data.delete(key),
	};
}

function run(names, sandbox) {
	const context = vm.createContext(sandbox);
	for (const name of [].concat(names)) vm.runInContext(readAdhd(name), context, { filename: name });
	return sandbox;
}

// ---- timer complete: the event carries { mode, minutes } ----------------------------------------------------

function loadTimer({ stubPanel } = {}) {
	const events = [];
	const banners = [];
	const sandbox = {
		console: { log() {}, warn() {}, error() {} },
		setTimeout,
		clearTimeout,
		setInterval: () => 1,
		clearInterval() {},
		Notification: undefined,
		CustomEvent: class {
			constructor(type, init = {}) {
				this.type = type;
				this.detail = init.detail === undefined ? null : init.detail;
			}
		},
		document: {
			getElementById: () => null,
			dispatchEvent: (event) => events.push(event),
			addEventListener() {},
		},
		window: {},
		$: () => makeChain(),
		__: translate,
		moment: (value) => {
			let time = Date.parse(`${value.replace(" ", "T")}Z`);
			return {
				subtract(amount) {
					time -= amount * 60000;
					return this;
				},
				format: () => new Date(time).toISOString().slice(0, 19).replace("T", " "),
			};
		},
		erpnext: { adhd: {} },
		frappe: {
			boot: { adhd_mode: true },
			provide() {},
			defaultDatetimeFormat: "YYYY-MM-DD HH:mm:ss",
			datetime: { now_datetime: () => "2026-09-21 10:00:00" },
			show_alert() {},
			utils: { escape_html: (value) => String(value) },
		},
	};
	if (stubPanel) {
		// a focus panel that predates { mode, minutes }: it returns nothing from _timerComplete
		sandbox.erpnext.adhd.FocusPanel = class {
			_renderTasks() {}
			_timerStart() {
				this.timerRunning = true;
			}
			_timerReset(seconds) {
				this.timerSeconds = seconds;
				this.timerTotalSeconds = seconds;
			}
			_timerComplete() {
				this.timerRunning = false;
			}
		};
		run(["adhd_time_log.js", "adhd_timebox_timer.js"], sandbox);
	} else {
		// the bundle's order
		run(["focus_panel.js", "adhd_time_log.js", "adhd_timebox_timer.js"], sandbox);
	}
	const panel = Object.create(sandbox.erpnext.adhd.FocusPanel.prototype);
	Object.assign(panel, {
		timerMode: "work",
		timerSeconds: 25 * 60,
		timerTotalSeconds: 25 * 60,
		timerRunning: false,
		activeTask: { name: "TASK-1", subject: "Write the docs" },
	});
	panel._renderTimeLogBanner = (options) => banners.push(options);
	return { panel, events, banners };
}

test("focuspanel:timercomplete carries the mode and minutes of the session that ran out", () => {
	const { panel, events } = loadTimer();
	panel._timerReset(50 * 60, "work");
	panel._timerStart();
	panel._timerComplete();
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "focuspanel:timercomplete");
	assert.deepEqual(plain(events[0].detail), { mode: "work", minutes: 50 });

	// the automatic break that follows reports itself as a break, so a listener can skip it
	panel._timerStart();
	panel._timerComplete();
	assert.equal(events.length, 2);
	assert.deepEqual(plain(events[1].detail), { mode: "break", minutes: 5 });
});

test("a finished break fires the event but is never offered for time logging", () => {
	const { panel, events, banners } = loadTimer();
	panel._timerReset(5 * 60, "break");
	panel._timerStart();
	panel._timerComplete();
	assert.equal(events[0].detail.mode, "break");
	assert.equal(banners.length, 0);

	panel._timerReset(25 * 60, "work");
	panel._timerStart();
	panel._timerComplete();
	assert.equal(events[1].detail.mode, "work");
	assert.equal(banners.length, 1);
	assert.equal(banners[0].hours, events[1].detail.minutes / 60);
});

test("without a { mode, minutes } result the event still fires (null detail) and the log falls back", () => {
	const { panel, events, banners } = loadTimer({ stubPanel: true });
	panel._timerReset(25 * 60);
	panel._timerStart();
	assert.doesNotThrow(() => panel._timerComplete());
	assert.equal(events.length, 1);
	assert.equal(events[0].detail, null);
	// the session length it counted itself, since the panel did not say
	assert.equal(banners.length, 1);
	assert.equal(banners[0].hours, 25 / 60);
});

// ---- "Done Well" on submit ------------------------------------------------------------------------------------

function loadMode({ active = true, doneWell = true } = {}) {
	const registrations = {};
	const alerts = [];
	const classes = new Set();
	const settings = { done_well: doneWell };
	const sandbox = {
		console: { log() {}, warn() {}, error() {} },
		setTimeout,
		clearTimeout,
		setInterval: () => 1,
		clearInterval() {},
		localStorage: makeStorage(),
		$: () => ({ on() {} }),
		__: translate,
		document: {
			activeElement: null,
			addEventListener() {},
			querySelector: () => null,
			getElementById: () => null,
			body: {
				offsetWidth: 0,
				classList: {
					add: (name) => classes.add(name),
					remove: (name) => classes.delete(name),
				},
				setAttribute() {},
			},
		},
		window: { ADHDSettings: { get: (key) => settings[key] } },
		frappe: {
			boot: {},
			session: { user: "ann@example.com" },
			provide() {},
			after_ajax() {},
			show_alert: (alert) => alerts.push(alert),
			ui: {
				form: { on: (doctype, handlers) => Object.assign((registrations[doctype] ||= {}), handlers) },
			},
		},
		erpnext: { adhd: {} },
	};
	run("adhd_mode.js", sandbox);
	sandbox.erpnext.adhd.mode._apply(active, false);
	return { handlers: registrations["*"], alerts, settings, sandbox };
}

test("Done Well listens for on_submit, the event Frappe fires after a submit; after_submit never fires", () => {
	const { handlers } = loadMode();
	assert.equal(typeof handlers.on_submit, "function");
	assert.equal(handlers.after_submit, undefined);
	// the save-time telemetry hooks are still registered
	assert.equal(typeof handlers.before_save, "function");
	assert.equal(typeof handlers.after_save, "function");
});

test("a submit shows the reinforcement once, and only with the mode and the done_well setting on", () => {
	const frm = { doc: { doctype: "Sales Invoice", name: "SINV-1" } };

	const on = loadMode();
	on.handlers.on_submit(frm);
	assert.equal(on.alerts.length, 1);
	assert.equal(on.alerts[0].message, "Sales Invoice SINV-1 submitted.");

	const settingOff = loadMode({ doneWell: false });
	settingOff.handlers.on_submit(frm);
	assert.equal(settingOff.alerts.length, 0);

	const modeOff = loadMode({ active: false });
	modeOff.handlers.on_submit(frm);
	assert.equal(modeOff.alerts.length, 0);
});

// ---- Purchase Order steps -------------------------------------------------------------------------------------

function loadBuying() {
	const panels = [];
	const node = () => {
		const self = {
			classes: [],
			label: "",
			children: [],
			addClass(name) {
				self.classes.push(name);
				return self;
			},
			text(value) {
				self.label = value;
				return self;
			},
			on() {
				return self;
			},
			append(child) {
				self.children.push(child);
				return self;
			},
			closest: () => ({ length: 0 }),
		};
		return self;
	};
	const sandbox = {
		console,
		__: translate,
		flt: (value) => Number.parseFloat(value) || 0,
		$: (html) => Object.assign(node(), { html }),
		erpnext: { adhd: { isActive: () => true } },
		frappe: {
			provide() {},
			model: { open_mapped_doc() {} },
			db: { get_value: async () => ({ message: {} }) },
		},
	};
	run("adhd_buying.js", sandbox);
	const render = (doc) => {
		panels.length = 0;
		const wrapper = {
			find: () => ({ remove() {}, first: () => ({ length: 0 }) }),
			prepend: (panel) => panels.push(panel),
		};
		sandbox.erpnext.adhd.initPurchaseOrderStatusPanel({
			doctype: "Purchase Order",
			doc,
			layout: { $wrapper: wrapper },
		});
		return panels[0];
	};
	return { step: sandbox.erpnext.adhd.getPurchaseOrderStep, render };
}

test("a fully billed Purchase Order that is not fully received is still waiting for its receipt", () => {
	const { step } = loadBuying();
	// status "To Receive": per_received < 100 and per_billed == 100 (erpnext/controllers/status_updater.py)
	assert.equal(
		step({ docstatus: 1, status: "To Receive", per_received: 0, per_billed: 100 }),
		"receipt_pending"
	);
	assert.equal(
		step({ docstatus: 1, status: "To Receive", per_received: 60, per_billed: 100 }),
		"receipt_pending"
	);
	assert.equal(
		step({ docstatus: 1, status: "To Bill", per_received: 100, per_billed: 40 }),
		"invoice_pending"
	);
	assert.equal(step({ docstatus: 1, status: "Completed", per_received: 100, per_billed: 100 }), "closed");
	assert.equal(step({ docstatus: 1, status: "Closed", per_received: 0, per_billed: 0 }), "closed");
	// a drop-ship order the supplier already delivered has nothing left to receive
	assert.equal(
		step({ docstatus: 1, status: "Delivered", per_received: 0, per_billed: 0 }),
		"invoice_pending"
	);
	assert.equal(step({ docstatus: 1, status: "Delivered", per_received: 0, per_billed: 100 }), "closed");
	assert.equal(step({ docstatus: 2, status: "Cancelled", per_received: 100, per_billed: 100 }), null);
});

test("Create Purchase Receipt stays available on a fully billed order, and not on hold", () => {
	const { render } = loadBuying();
	const button = (panel) =>
		panel.children.find((child) => child.classes.join(" ").includes("adhd-next-action"));

	const billedNotReceived = render({
		docstatus: 1,
		status: "To Receive",
		per_received: 0,
		per_billed: 100,
	});
	assert.equal(button(billedNotReceived)?.label, "Create Purchase Receipt");

	const toBill = render({ docstatus: 1, status: "To Bill", per_received: 100, per_billed: 0 });
	assert.equal(button(toBill)?.label, "Create Purchase Invoice");

	const completed = render({ docstatus: 1, status: "Completed", per_received: 100, per_billed: 100 });
	assert.equal(button(completed), undefined);

	// the standard form offers no Create actions while the order is on hold
	const onHold = render({ docstatus: 1, status: "On Hold", per_received: 0, per_billed: 0 });
	assert.equal(button(onHold), undefined);
});

// ---- Opportunity stage bar ------------------------------------------------------------------------------------

function loadOpportunityBar() {
	const layout = [];
	const registrations = [];
	const child = (owner, selector) =>
		new Proxy(
			{},
			{
				get(_target, key) {
					if (key === "on") {
						return (event, handler) => {
							owner.handlers[`${selector}:${event}`] = handler;
							return child(owner, selector);
						};
					}
					return () => child(owner, selector);
				},
			}
		);
	const makeNode = (html) => {
		const node = { html, handlers: {}, length: 1 };
		node.find = (selector) => child(node, selector);
		node.on = () => node;
		node.addClass = () => node;
		node.remove = () => node;
		return node;
	};
	const wrapperSelection = {
		find: () => ({
			remove() {
				layout.length = 0;
				return this;
			},
			first: () => ({ prepend: (node) => layout.push(node), length: 1 }),
			length: 0,
		}),
	};
	const confirms = [];
	const sandbox = {
		console,
		Date,
		Map,
		Promise,
		Set,
		Number,
		String,
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		clearInterval() {},
		clearTimeout() {},
		setInterval: () => 1,
		setTimeout: () => 1,
		localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
		locals: {},
		window: { setTimeout },
		$: (input) => (typeof input === "string" ? makeNode(input) : wrapperSelection),
		__: translate,
		cint: (value) => Number.parseInt(value || 0, 10),
		flt: (value) => Number.parseFloat(value || 0),
		format_currency: (value) => String(value),
		format_number: (value) => String(value),
		erpnext: { adhd: {}, work_order: {} },
		frappe: {
			boot: { adhd_mode: true },
			call: async () => ({ message: 0 }),
			confirm: (...args) => confirms.push(args),
			datetime: { get_today: () => "2026-09-20", add_days: (value) => value, get_diff: () => 0 },
			db: { get_list: async () => [], get_value: async () => ({ message: {} }) },
			model: {},
			provide() {},
			session: { user: "user@example.com" },
			show_alert() {},
			msgprint() {},
			ui: { form: { on: (doctype, handlers) => registrations.push({ doctype, handlers }) } },
			utils: { escape_html: (value) => String(value) },
		},
	};
	run("adhd_tickets_041_061.js", sandbox);
	const refresh = registrations.find((entry) => entry.doctype === "Opportunity").handlers.refresh;

	// what a real Form does for what the bar calls: trigger() runs a handler, set_value() and save() write
	function render(doc, { perm = 1, isNew = false } = {}) {
		const calls = [];
		const frm = {
			doc,
			wrapper: {},
			perm: [{ write: perm }],
			is_new: () => isNew,
			trigger: (event) => calls.push(["trigger", event]),
			set_value: () => calls.push(["set_value"]),
			save: () => calls.push(["save"]),
		};
		layout.length = 0;
		refresh(frm);
		const node = layout.find((entry) => entry.html.includes("adhd-pipeline"));
		const stages = Object.fromEntries(
			[...node.html.matchAll(/<button[^>]*data-status="([^"]+)"([^>]*)>/g)].map((match) => [
				match[1],
				{
					disabled: /\bdisabled\b/.test(match[2]),
					action: /data-action="([^"]+)"/.exec(match[2])?.[1],
				},
			])
		);
		const click = (action) => node.handlers["button[data-action]:click"].call({ dataset: { action } });
		return { calls, frm, stages, click, confirms };
	}
	return { render, sandbox };
}

test("ADHD-049 only stages with a standard action are clickable; the rest are display-only", () => {
	const { render } = loadOpportunityBar();
	const { stages } = render({ status: "Open" });
	assert.deepEqual(plain(Object.keys(stages)), ["Open", "Replied", "Quotation", "Converted", "Lost"]);
	assert.equal(stages.Quotation.action, "quotation");
	assert.equal(stages.Lost.action, "lost");
	for (const status of ["Open", "Replied", "Converted"]) {
		assert.equal(stages[status].disabled, true, `${status} must be display-only`);
		assert.equal(stages[status].action, undefined);
	}
});

test("ADHD-049 Closed Lost opens the standard lost-reason dialog instead of writing the status", () => {
	const { render } = loadOpportunityBar();
	const bar = render({ status: "Replied" });
	bar.click(bar.stages.Lost.action);
	assert.deepEqual(plain(bar.calls), [["trigger", "set_as_lost_dialog"]]);
	assert.equal(bar.confirms.length, 0);
});

test("ADHD-049 Proposal runs the standard make_quotation flow instead of writing the status", () => {
	const { render } = loadOpportunityBar();
	const bar = render({ status: "Open" });
	bar.click(bar.stages.Quotation.action);
	assert.deepEqual(plain(bar.calls), [["trigger", "create_quotation"]]);
});

test("ADHD-049 nothing is offered where the standard form offers nothing", () => {
	const { render } = loadOpportunityBar();
	// already Lost: the standard Create buttons and the lost dialog are gone until it is reopened
	const lost = render({ status: "Lost" });
	assert.equal(lost.stages.Quotation.action, undefined);
	assert.equal(lost.stages.Lost.action, undefined);
	lost.click("lost");
	lost.click("quotation");
	assert.deepEqual(plain(lost.calls), []);

	// not saved yet
	const fresh = render({ status: "Open" }, { isNew: true });
	assert.equal(fresh.stages.Quotation.action, undefined);
	assert.equal(fresh.stages.Lost.action, undefined);

	// declaring lost saves the document, which needs write permission
	const readOnly = render({ status: "Open" }, { perm: 0 });
	assert.equal(readOnly.stages.Lost.action, undefined);
	assert.equal(readOnly.stages.Quotation.action, "quotation");

	// a Converted opportunity has moved past Proposal, so it is not offered again, but can still be declared lost
	const converted = render({ status: "Converted" });
	assert.equal(converted.stages.Quotation.action, undefined);
	assert.equal(converted.stages.Lost.action, "lost");
});

// ---- notifications --------------------------------------------------------------------------------------------

function loadNotifications() {
	const intervals = [];
	const cleared = [];
	const bound = [];
	const unbound = [];
	const timeouts = [];
	let onState;
	const sandbox = {
		console,
		Date,
		Object,
		JSON,
		Math,
		parseInt,
		document: {},
		localStorage: makeStorage(),
		setInterval: (fn, ms) => intervals.push({ fn, ms }),
		clearInterval: (id) => id != null && cleared.push(id),
		setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
		$: () => ({
			on(event, selector, fn) {
				bound.push({ event, selector, fn });
				return this;
			},
			off(event) {
				unbound.push(event);
				return this;
			},
		}),
		__: translate,
		erpnext: { adhd: { onStateChange: (fn) => (onState = fn) } },
		frappe: { boot: { adhd_mode: true }, provide() {}, show_alert() {} },
	};
	run("adhd_notifications.js", sandbox);
	const setMode = (active) => {
		sandbox.frappe.boot.adhd_mode = active;
		onState(active);
	};
	return { sandbox, intervals, cleared, bound, unbound, timeouts, setMode };
}

test("switching ADHD mode off stops the snooze checker and the bell handler, and on restarts them once", () => {
	const env = loadNotifications();
	env.setMode(true);
	assert.equal(env.intervals.length, 1);
	assert.equal(env.bound.length, 1);
	assert.equal(env.cleared.length, 0);

	env.setMode(false);
	assert.deepEqual(plain(env.cleared), [1], "the running interval must be cleared");
	assert.equal(env.unbound.at(-1), env.bound[0].event, "the click handler must be taken off");

	env.setMode(true);
	assert.equal(env.intervals.length, 2, "one new interval, not a second one on top of a running one");
	assert.equal(env.bound.length, 2);
	// switching on again while on must not stack another interval
	const before = env.intervals.length;
	env.setMode(true);
	assert.equal(env.intervals.length, before + 1);
	assert.equal(env.cleared.at(-1), before, "the previous interval is cleared before the new one starts");
});

test("the notification bell handler and the interval do nothing while the mode is off at run time", () => {
	const env = loadNotifications();
	env.setMode(true);
	const click = env.bound[0].fn;

	click();
	assert.equal(env.timeouts.length, 1, "the panel is enhanced while the mode is on");

	env.sandbox.frappe.boot.adhd_mode = false;
	click();
	assert.equal(env.timeouts.length, 1, "no panel work once the mode is off");

	// a tick that fires after the mode went off stops the interval instead of carrying on
	env.intervals[0].fn();
	assert.equal(env.cleared.at(-1), 1);
});
