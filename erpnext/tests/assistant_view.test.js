// Tests for the assistant's client renderers (erpnext.assistant.view): what the chat panel and the command bar draw.
// The subject and sender of a received email are written by strangers and reach these renderers as
// items[].label, items[].meta and items[].route, so every test below feeds them hostile text.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../public/js/assistant/assistant_view.js"), "utf8");

const HOSTILE_LABEL = "<img src=x onerror=alert(1)>";
const HOSTILE_META = `"><script>alert(1)</script> & 'single' "double" \`tick\` a=b`;

// values created inside a vm context have that context's prototypes, which deepStrictEqual rejects
const plain = (value) => JSON.parse(JSON.stringify(value));
const translate = (text, values = []) =>
	values.reduce((result, value, index) => result.replace(`{${index}}`, value), text);

// Copied from frappe/public/js/frappe/utils/utils.js (escape_html and unescape_html), including the
// backtick and equals sign, which are what stop "onerror=" from surviving as text.
const ESCAPES = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
	"`": "&#x60;",
	"=": "&#x3D;",
};
const UNESCAPES = Object.fromEntries(Object.entries(ESCAPES).map(([char, entity]) => [entity, char]));
const escapeHtml = (txt) => {
	if (txt == null) return "";
	return String(txt).replace(/[&<>"'`=]/g, (char) => ESCAPES[char] || char);
};
const unescapeHtml = (txt) =>
	String(txt).replace(
		/&amp;|&lt;|&gt;|&quot;|&#39;|&#x60;|&#x3D;/g,
		(entity) => UNESCAPES[entity] || entity
	);

// ---- a small strict HTML reader ----------------------------------------------------------------------------
// It accepts only the renderer's own tags and attributes, with quoted values that hold no raw < or >. Anything
// else (an injected tag, an attribute that escaped its quotes, a stray < in text, unbalanced tags) fails here.

const ALLOWED_TAGS = new Set(["div", "span", "a", "button", "em", "small"]);
const ALLOWED_ATTRIBUTES = new Set([
	"class",
	"href",
	"data-route",
	"data-chip",
	"data-card",
	"type",
	"disabled",
]);
const OPEN_TAG = /<([a-z]+)((?:\s+[a-z-]+(?:=(?:"[^"<>]*"|'[^'<>]*'))?)*)\s*>/y;
const CLOSE_TAG = /<\/([a-z]+)>/y;
const ATTRIBUTE = /([a-z-]+)(?:=(?:"([^"]*)"|'([^']*)'))?/g;

function tokenize(html) {
	const tokens = [];
	const stack = [];
	let index = 0;
	while (index < html.length) {
		if (html[index] !== "<") {
			const end = html.indexOf("<", index);
			const text = html.slice(index, end === -1 ? html.length : end);
			assert.ok(!text.includes(">"), `stray ">" in text: ${text}`);
			tokens.push({ type: "text", text });
			index += text.length;
			continue;
		}
		CLOSE_TAG.lastIndex = index;
		const close = CLOSE_TAG.exec(html);
		if (close) {
			assert.equal(stack.pop(), close[1], `unbalanced </${close[1]}>`);
			tokens.push({ type: "close", name: close[1] });
			index = CLOSE_TAG.lastIndex;
			continue;
		}
		OPEN_TAG.lastIndex = index;
		const open = OPEN_TAG.exec(html);
		assert.ok(
			open,
			`a "<" that does not start one of the renderer's own tags: ${html.slice(index, index + 80)}`
		);
		assert.ok(ALLOWED_TAGS.has(open[1]), `tag <${open[1]}> is not one the renderer draws`);
		const attrs = {};
		const quotes = {};
		for (const match of open[2].matchAll(ATTRIBUTE)) {
			assert.ok(
				ALLOWED_ATTRIBUTES.has(match[1]),
				`attribute ${match[1]} is not one the renderer writes`
			);
			assert.ok(!Object.hasOwn(attrs, match[1]), `attribute ${match[1]} appears twice`);
			if (match[2] !== undefined) {
				attrs[match[1]] = match[2];
				quotes[match[1]] = '"';
			} else if (match[3] !== undefined) {
				attrs[match[1]] = match[3];
				quotes[match[1]] = "'";
			} else {
				attrs[match[1]] = true;
			}
		}
		tokens.push({ type: "open", name: open[1], attrs, quotes });
		stack.push(open[1]);
		index = OPEN_TAG.lastIndex;
	}
	assert.deepEqual(stack, [], "tags left open");
	return tokens;
}

const opens = (tokens, name) => tokens.filter((t) => t.type === "open" && t.name === name);
const hasClass = (token, name) =>
	String(token.attrs.class || "")
		.split(/\s+/)
		.includes(name);
const withClass = (tokens, name) => tokens.filter((t) => t.type === "open" && hasClass(t, name));
// the visible text, one entry per text node, entities decoded the way a browser decodes them
const texts = (tokens) =>
	tokens
		.filter((t) => t.type === "text")
		.map((t) => unescapeHtml(t.text.trim()))
		.filter(Boolean);
// { create, open, discard } as { label, disabled, primary }, in document order
function buttons(html) {
	const tokens = tokenize(html);
	const found = {};
	const order = [];
	tokens.forEach((token, i) => {
		if (token.type !== "open" || token.name !== "button") return;
		const key = token.attrs["data-card"];
		found[key] = {
			label: tokens[i + 1].text.trim(),
			disabled: token.attrs.disabled === true,
			primary: hasClass(token, "btn-primary"),
			default: hasClass(token, "btn-default"),
		};
		order.push(key);
	});
	return { found, order };
}

// ---- loading the renderer -----------------------------------------------------------------------------------

function load() {
	const sandbox = { __: translate };
	sandbox.frappe = {
		provide(name) {
			name.split(".").reduce((scope, part) => (scope[part] = scope[part] || {}), sandbox);
		},
		utils: { escape_html: escapeHtml },
		// routes are set per test through get_route
		get_route: () => [],
	};
	vm.runInContext(source, vm.createContext(sandbox), { filename: "assistant_view.js" });
	return { view: sandbox.erpnext.assistant.view, frappe: sandbox.frappe };
}

// ---- 1. itemsHtml: hostile label and meta --------------------------------------------------------------------

test("itemsHtml escapes a hostile label and meta so nothing live is injected", () => {
	const { view } = load();
	const html = view.itemsHtml([
		{
			label: HOSTILE_LABEL,
			meta: HOSTILE_META,
			route: ["Form", "Communication", "COMM-1"],
			tone: "danger",
		},
		{ label: HOSTILE_LABEL, meta: HOSTILE_META },
		{ label: HOSTILE_META },
	]);

	// the raw hostile substrings never appear
	for (const raw of ["<img", "<script", "</script", "onerror=", '"><script', '"><img', "a=b"]) {
		assert.ok(!html.includes(raw), `${raw} survived in ${html}`);
	}
	// every "<" begins one of the renderer's own tags (the reader throws otherwise)
	const tokens = tokenize(html);
	const tagNames = new Set(tokens.filter((t) => t.type === "open").map((t) => t.name));
	assert.deepEqual([...tagNames].sort(), ["a", "div", "span"]);
	assert.equal(html.split("<").length - 1, tokens.filter((t) => t.type !== "text").length);
	assert.ok(!tokens.some((t) => t.type === "open" && Object.hasOwn(t.attrs, "onerror")));

	// the text is still readable: it comes back out unchanged once a browser decodes the entities
	const visible = texts(tokens);
	assert.equal(visible.filter((t) => t === HOSTILE_LABEL).length, 2);
	assert.equal(visible.filter((t) => t === HOSTILE_META).length, 3);
	assert.equal(withClass(tokens, "erp-assistant-item").length, 3);
	assert.equal(opens(tokens, "a").length, 1);
});

// ---- 2. data-route cannot be broken out of ---------------------------------------------------------------------

test("data-route is JSON, escaped into a single-quoted attribute, and round-trips", () => {
	const { view } = load();
	const route = [
		"Form",
		"Communication",
		`it's "quoted" <b>&amp; \`tick\` a=b'><img src=x onerror=alert(1)>`,
	];

	const itemsHtml = view.itemsHtml([{ label: "Subject", meta: "Sender", route }]);
	const createdHtml = view.createdHtml({ doctype: "ToDo", name: HOSTILE_LABEL, route });

	for (const html of [itemsHtml, createdHtml]) {
		const tokens = tokenize(html);
		const anchors = opens(tokens, "a");
		assert.equal(anchors.length, 1);
		const value = anchors[0].attrs["data-route"];
		assert.equal(anchors[0].quotes["data-route"], "'");
		// nothing inside can close the quote or the tag
		assert.ok(!/['"<>]/.test(value), `unescaped delimiter inside ${value}`);
		assert.ok(value.includes("&#39;"), "the apostrophe is escaped");
		// the only apostrophes in the whole output are the two delimiting the attribute
		assert.equal(html.split("'").length - 1, 2);
		assert.ok(!html.includes("<img") && !html.includes("onerror="));
		// what a browser hands back for the attribute parses to the original array, untouched
		assert.deepEqual(JSON.parse(unescapeHtml(value)), route);
	}
	// the created link shows the hostile record name as plain text
	assert.ok(texts(tokenize(createdHtml)).some((t) => t.includes(`Open ToDo ${HOSTILE_LABEL}`)));
	// no route, no link: a row without a route is a plain div
	const flat = tokenize(view.itemsHtml([{ label: HOSTILE_LABEL }]));
	assert.equal(opens(flat, "a").length, 0);
	assert.ok(!flat.some((t) => t.type === "open" && Object.hasOwn(t.attrs, "data-route")));
});

// ---- 3. messageHtml -------------------------------------------------------------------------------------------

test("messageHtml renders bot items, never renders m.text as HTML, and escapes user markup", () => {
	const { view } = load();
	const forgedLink = `<a href="#" class="erp-assistant-item" data-route='["Form","User","Administrator"]'>go</a>`;

	const bot = {
		role: "bot",
		text: `<b>Found</b> ${HOSTILE_LABEL} ${forgedLink}`,
		items: [
			{ label: HOSTILE_LABEL, meta: HOSTILE_META, route: ["Form", "Communication", "COMM-1"] },
			{ label: "plain" },
		],
	};
	const html = view.messageHtml(bot, true);
	assert.ok(!html.includes("<b>") && !html.includes("<img") && !html.includes("<script"));
	const tokens = tokenize(html);
	const [message] = withClass(tokens, "erp-assistant-msg");
	assert.ok(hasClass(message, "is-bot"));
	assert.equal(texts(tokens)[0], bot.text);
	// the two real rows are the only rows; the forged link in the text is not a link
	assert.equal(withClass(tokens, "erp-assistant-items").length, 1);
	assert.equal(withClass(tokens, "erp-assistant-item").length, 2);
	assert.equal(opens(tokens, "a").length, 1);
	assert.ok(texts(tokens).includes(HOSTILE_LABEL));

	// text is not what is drawn for a message with no items either: it is still escaped
	const noItems = tokenize(view.messageHtml({ role: "bot", text: forgedLink }, true));
	assert.equal(opens(noItems, "a").length, 0);
	assert.equal(withClass(noItems, "erp-assistant-items").length, 0);

	// reply is the fallback, and an error is marked
	const reply = tokenize(view.messageHtml({ role: "bot", reply: HOSTILE_LABEL, error: true }, true));
	assert.ok(hasClass(withClass(reply, "erp-assistant-msg")[0], "is-error"));
	assert.equal(texts(reply)[0], HOSTILE_LABEL);

	// chips are drawn only on the live message, and their labels are escaped too
	const chips = { role: "bot", text: "hi", chips: [{ label: HOSTILE_LABEL }] };
	assert.equal(withClass(tokenize(view.messageHtml(chips, true)), "erp-assistant-chip").length, 1);
	assert.equal(withClass(tokenize(view.messageHtml(chips, false)), "erp-assistant-chip").length, 0);

	// a user message with markup is escaped
	const userText = `<script>alert(1)</script> & "x" ${forgedLink}`;
	const userHtml = view.messageHtml({ role: "user", text: userText }, true);
	assert.ok(!userHtml.includes("<script"));
	const userTokens = tokenize(userHtml);
	assert.equal(userTokens.filter((t) => t.type === "open").length, 1);
	assert.ok(hasClass(userTokens[0], "is-user"));
	assert.equal(texts(userTokens)[0], userText);
});

// ---- 4. cardHtml ----------------------------------------------------------------------------------------------

function makeCard(extra = {}) {
	return {
		title: "Log a call",
		rows: [
			{ label: "Party", value: "Acme", status: "ok" },
			{ label: "Notes", value: "", status: "missing" },
		],
		problems: [],
		ready: true,
		...extra,
	};
}

test("cardHtml: Create is enabled only for a ready, live card", () => {
	const { view } = load();

	const ready = buttons(view.cardHtml(makeCard({ ready: true }), true));
	assert.deepEqual(ready.order, ["create", "open", "discard"]);
	assert.equal(ready.found.create.label, "Create");
	assert.equal(ready.found.create.disabled, false);
	assert.equal(ready.found.create.primary, true);
	assert.equal(ready.found.open.label, "Open in form");
	assert.equal(ready.found.open.disabled, false);
	assert.equal(ready.found.open.default, true);
	assert.equal(ready.found.discard.disabled, false);

	const notReady = buttons(view.cardHtml(makeCard({ ready: false }), true));
	assert.deepEqual(notReady.order, ["create", "open", "discard"]);
	assert.equal(notReady.found.create.disabled, true);
	assert.equal(notReady.found.open.disabled, false);
	assert.equal(notReady.found.discard.disabled, false);

	const stale = view.cardHtml(makeCard({ ready: true }), false);
	assert.ok(hasClass(withClass(tokenize(stale), "erp-assistant-card")[0], "is-stale"));
	const staleButtons = buttons(stale);
	assert.deepEqual(staleButtons.order, ["create", "open", "discard"]);
	for (const key of staleButtons.order) assert.equal(staleButtons.found[key].disabled, true, key);
});

test("cardHtml: a form_only card has no Create, a primary 'Open the form' and still a Discard", () => {
	const { view } = load();

	for (const ready of [true, false]) {
		const html = view.cardHtml(makeCard({ form_only: true, ready }), true);
		assert.ok(!html.includes('data-card="create"'));
		const live = buttons(html);
		assert.deepEqual(live.order, ["open", "discard"], `ready=${ready}`);
		assert.equal(live.found.open.label, "Open the form");
		assert.equal(live.found.open.primary, true);
		assert.equal(live.found.open.default, false);
		assert.equal(live.found.open.disabled, false);
		assert.equal(live.found.discard.label, "Discard");
		assert.equal(live.found.discard.disabled, false);
	}

	// a stale form_only card: the form button and Discard are disabled, and there is still no Create
	const stale = buttons(view.cardHtml(makeCard({ form_only: true, ready: true }), false));
	assert.deepEqual(stale.order, ["open", "discard"]);
	assert.equal(stale.found.open.label, "Open the form");
	assert.equal(stale.found.open.disabled, true);
	assert.equal(stale.found.discard.disabled, true);
});

test("cardHtml escapes hostile card text: title, row label, value, note and problems", () => {
	const { view } = load();
	const card = makeCard({
		title: HOSTILE_LABEL,
		rows: [
			{ label: HOSTILE_LABEL, value: HOSTILE_META, status: "ambiguous", note: HOSTILE_META },
			{ label: "Empty", value: null, status: "none" },
		],
		problems: [HOSTILE_LABEL, HOSTILE_META],
	});

	for (const live of [true, false]) {
		const html = view.cardHtml(card, live);
		for (const raw of ["<img", "<script", "onerror=", '"><script', '"><img', "a=b"]) {
			assert.ok(!html.includes(raw), `${raw} survived in ${html}`);
		}
		const tokens = tokenize(html);
		const visible = texts(tokens);
		assert.ok(visible.includes(HOSTILE_LABEL));
		assert.ok(visible.includes(HOSTILE_META));
		assert.equal(visible.filter((t) => t === HOSTILE_LABEL).length, 3); // title, row label, problem
		assert.equal(withClass(tokens, "erp-assistant-problem").length, 2);
		// an empty value shows a dash, and its status flag is drawn
		assert.ok(html.includes("&mdash;"));
		assert.ok(visible.includes("not found"));
	}
});

// ---- 5. openInForm ----------------------------------------------------------------------------------------------

function loadForm({ defer = false } = {}) {
	const loaded = load();
	const log = { doctypes: [], docs: [], children: [], routes: [] };
	const pending = [];
	loaded.frappe.model = {
		with_doctype(doctype, callback) {
			log.doctypes.push(doctype);
			if (defer) pending.push(callback);
			else callback();
		},
		get_new_doc(doctype) {
			const doc = {
				doctype,
				name: `new-${doctype.toLowerCase().replace(/ /g, "-")}-x1y2z3`,
				__islocal: 1,
			};
			log.docs.push(doc);
			return doc;
		},
		add_child(doc, field, row) {
			const child = { ...row, parentfield: field, parent: doc.name };
			doc[field] = (doc[field] || []).concat(child);
			log.children.push([doc, field, row]);
			return child;
		},
	};
	loaded.frappe.set_route = (...args) => log.routes.push(args);
	return { ...loaded, log, pending };
}

test("openInForm copies every prefill value onto a new doc, including null, then opens it", () => {
	const { view, log } = loadForm();
	view.openInForm({
		doctype: "Email Account",
		prefill: { email_id: "sam@example.com", enable_incoming: 1, service: null, incoming_port: "993" },
	});

	assert.deepEqual(log.doctypes, ["Email Account"]);
	assert.equal(log.docs.length, 1);
	const [doc] = log.docs;
	assert.equal(doc.doctype, "Email Account");
	assert.equal(doc.email_id, "sam@example.com");
	assert.equal(doc.enable_incoming, 1);
	assert.ok(Object.hasOwn(doc, "service"), "a null prefill is still written");
	assert.equal(doc.service, null);
	assert.equal(doc.incoming_port, "993");
	assert.equal(log.children.length, 0);
	assert.deepEqual(plain(log.routes), [["Form", "Email Account", doc.name]]);
});

test("openInForm adds child rows for an array value, and copes with a card that has no prefill", () => {
	const { view, log } = loadForm();
	const rows = [{ role: "Sales User" }, { role: "Sales Manager" }];
	view.openInForm({ doctype: "User", prefill: { email: "sam@example.com", roles: rows } });

	const [doc] = log.docs;
	assert.equal(doc.email, "sam@example.com");
	assert.equal(log.children.length, 2);
	log.children.forEach(([parent, field, row], i) => {
		assert.equal(parent, doc);
		assert.equal(field, "roles");
		assert.equal(row, rows[i]);
	});
	// the array was not copied across as a plain value: the rows came from add_child
	assert.deepEqual(
		plain(doc.roles).map((r) => [r.role, r.parentfield]),
		[
			["Sales User", "roles"],
			["Sales Manager", "roles"],
		]
	);
	assert.deepEqual(plain(log.routes), [["Form", "User", doc.name]]);

	const bare = loadForm();
	bare.view.openInForm({ doctype: "ToDo" });
	assert.deepEqual(plain(bare.log.routes), [["Form", "ToDo", bare.log.docs[0].name]]);
});

test("openInForm waits for the doctype to load before it builds the doc or changes the route", () => {
	const { view, log, pending } = loadForm({ defer: true });
	view.openInForm({ doctype: "Email Account", prefill: { email_id: "sam@example.com" } });

	assert.deepEqual(log.doctypes, ["Email Account"]);
	assert.equal(log.docs.length, 0);
	assert.equal(log.routes.length, 0);
	pending.forEach((callback) => callback());
	assert.equal(log.docs.length, 1);
	assert.equal(log.routes.length, 1);
});

// ---- 6. currentContext --------------------------------------------------------------------------------------------

test("currentContext reads the open record from a Form route", () => {
	const { view, frappe } = load();
	const at = (route) => {
		frappe.get_route = () => route;
		return plain(view.currentContext());
	};

	assert.deepEqual(at(["Form", "Customer", "Acme"]), { doctype: "Customer", name: "Acme" });
	// a record that has not been saved yet is not something to attach to
	assert.equal(at(["Form", "Customer", "new-customer-abc123"]), null);
	// lists, reports and half-formed routes are not records either
	assert.equal(at(["List", "Customer"]), null);
	assert.equal(at(["List", "Customer", "List"]), null);
	assert.equal(at(["Form", "Customer"]), null);
	assert.equal(at([]), null);
	// frappe.get_route() has already decoded the parts, so a name is taken as it comes (see the next tests)
	assert.deepEqual(at(["Form", "Customer", "Acme Corp & Sons"]), {
		doctype: "Customer",
		name: "Acme Corp & Sons",
	});

	// no router at all (a page that has not booted it) reads as no context
	frappe.get_route = undefined;
	assert.equal(view.currentContext(), null);
});

// frappe.get_route() already returns URL-decoded parts (router.js decode_component), so decoding again threw
// "URI malformed" for a record whose name contains a bare "%" and silently changed one containing "%20".
test("currentContext keeps a record name that is already decoded, such as one containing a percent sign", () => {
	const { view, frappe } = load();
	frappe.get_route = () => ["Form", "Pricing Rule", "Summer 50% off"];
	assert.deepEqual(plain(view.currentContext()), { doctype: "Pricing Rule", name: "Summer 50% off" });
	frappe.get_route = () => ["Form", "Customer", "A%20B"];
	assert.deepEqual(plain(view.currentContext()), { doctype: "Customer", name: "A%20B" });
});

test("currentContext asks Frappe whether the form is unsaved instead of guessing from the name", () => {
	const { view, frappe } = load();
	frappe.get_route = () => ["Form", "Lead", "new-lead-abc123"];
	frappe.get_doc = () => ({ __islocal: 1 });
	assert.equal(view.currentContext(), null, "a local document is not a record yet");
	// a saved record that merely starts with "new-" is still a record
	frappe.get_route = () => ["Form", "Customer", "new-york-store"];
	frappe.get_doc = () => ({ name: "new-york-store" });
	assert.deepEqual(plain(view.currentContext()), { doctype: "Customer", name: "new-york-store" });
});
