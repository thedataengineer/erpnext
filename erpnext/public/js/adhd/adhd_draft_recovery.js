// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
// ADHD-023: Sales Order / Quotation interruption restore.
//
// A local safety net only. While a Sales Order or Quotation draft is being edited, a snapshot of the unsaved
// form is kept in this browser's localStorage every ~30 seconds, and the next time the form is opened the
// person is asked "Resume it?". It never saves, submits or writes anything to the server: an earlier
// version auto-saved half-edited forms through server validation and was removed on purpose.

frappe.provide("erpnext.adhd");

(() => {
	const RECOVERY_DOCTYPES = ["Sales Order", "Quotation"];
	// One slot per user and doctype for a form that has no name yet (its local name changes every time)
	const NEW_DOC_NAME = "__new__";
	const KEY_PREFIX = "adhd_draft:";
	const SNAPSHOT_VERSION = 1;
	const SNAPSHOT_INTERVAL_MS = 30 * 1000;
	const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
	// A snapshot holds customer names, prices and addresses: keep few of them, and none that are large.
	const MAX_SNAPSHOTS_PER_USER = 20;
	const MAX_SNAPSHOT_CHARS = 150 * 1000;
	const systemTimeZone = () => frappe.boot && frappe.boot.time_zone && frappe.boot.time_zone.system;

	// Every field below was checked against sales_order.json, quotation.json and the child DocType JSONs.
	//  - `scalars` are restored one at a time, in this order, before the child tables. Each has a handler that
	//    can rewrite the ones after it (the party fetches its details, `transaction_date` clears
	//    `delivery_date`, `delivery_date` overwrites every item row, `tc_name` fetches `terms`, an address
	//    picks the taxes), so a field must come after the ones that would overwrite it.
	//  - `lateScalars` are restored after the child tables, because their handlers recalculate the totals.
	//  - Read-only fields the server or the totals calculation recomputes (amount, net_*, base_*, stock_qty,
	//    totals, allocated_amount, ...) are left out. Read-only fields that are fetched once when an item is
	//    picked and then used as inputs (stock_uom, conversion_factor, price_list_rate, weight_per_unit) are kept:
	//    restoring rows writes them straight onto the row, so no item trigger runs to fetch them again.
	//  - `identity` is what makes a child row worth keeping: an empty grid row is not.
	const SNAPSHOT_FIELDS = {
		"Sales Order": {
			party: ["customer"],
			scalars: [
				"company",
				"customer",
				"order_type",
				"transaction_date",
				"currency",
				"selling_price_list",
				"customer_address",
				"contact_person",
				"shipping_address_name",
				"tax_category",
				"taxes_and_charges",
				"shipping_rule",
				"payment_terms_template",
				"delivery_date",
				"po_no",
				"po_date",
				"set_warehouse",
				"project",
				"cost_center",
				"sales_partner",
				"incoterm",
				"named_place",
				"tc_name",
				"terms",
				"ignore_pricing_rule",
				"disable_rounded_total",
				"reserve_stock",
			],
			lateScalars: ["apply_discount_on", "additional_discount_percentage", "discount_amount"],
			tables: {
				items: {
					doctype: "Sales Order Item",
					identity: ["item_code", "item_name"],
					fields: [
						"item_code",
						"item_name",
						"description",
						"delivery_date",
						"qty",
						"uom",
						"stock_uom",
						"conversion_factor",
						"price_list_rate",
						"margin_type",
						"margin_rate_or_amount",
						"discount_percentage",
						"discount_amount",
						"rate",
						"warehouse",
						"item_tax_template",
						"additional_notes",
						"weight_per_unit",
						"weight_uom",
						"product_bundle",
						"blanket_order",
						"against_blanket_order",
						"delivered_by_supplier",
						"supplier",
						"cost_center",
						"project",
						"bom_no",
					],
				},
				taxes: {
					doctype: "Sales Taxes and Charges",
					identity: ["account_head", "description"],
					// tax_amount is only an input for the "Actual" charge type; the others are recalculated
					fields: [
						"charge_type",
						"row_id",
						"account_head",
						"cost_center",
						"description",
						"included_in_print_rate",
						"rate",
						"tax_amount",
						"project",
					],
				},
				sales_team: {
					doctype: "Sales Team",
					identity: ["sales_person"],
					fields: ["sales_person", "allocated_percentage", "incentives"],
				},
			},
		},
		// Quotation has no customer, delivery_date, po_no, project, cost_center or sales_team field: its party is
		// quotation_to + party_name.
		Quotation: {
			party: ["party_name"],
			scalars: [
				"company",
				"quotation_to",
				"party_name",
				"order_type",
				"transaction_date",
				"valid_till",
				"currency",
				"selling_price_list",
				"customer_address",
				"contact_person",
				"shipping_address_name",
				"tax_category",
				"taxes_and_charges",
				"shipping_rule",
				"payment_terms_template",
				"referral_sales_partner",
				"incoterm",
				"named_place",
				"tc_name",
				"terms",
				"ignore_pricing_rule",
				"disable_rounded_total",
			],
			lateScalars: ["apply_discount_on", "additional_discount_percentage", "discount_amount"],
			tables: {
				items: {
					doctype: "Quotation Item",
					identity: ["item_code", "item_name"],
					fields: [
						"item_code",
						"item_name",
						"description",
						"qty",
						"uom",
						"stock_uom",
						"conversion_factor",
						"price_list_rate",
						"margin_type",
						"margin_rate_or_amount",
						"discount_percentage",
						"discount_amount",
						"rate",
						"warehouse",
						"item_tax_template",
						"additional_notes",
						"weight_per_unit",
						"weight_uom",
						"product_bundle",
						"blanket_order",
						"against_blanket_order",
						"is_alternative",
					],
				},
				taxes: {
					doctype: "Sales Taxes and Charges",
					identity: ["account_head", "description"],
					fields: [
						"charge_type",
						"row_id",
						"account_head",
						"cost_center",
						"description",
						"included_in_print_rate",
						"rate",
						"tax_amount",
						"project",
					],
				},
			},
		},
	};

	// Everything here is per form being edited. Only one form is on screen at a time.
	const state = {
		frm: null,
		docname: null,
		timer: null,
		// what was last written for which document: an unchanged form writes nothing
		lastWrite: null,
		// the document whose "Resume it?" banner is waiting for an answer: its snapshot must not be
		// overwritten by whatever the person types in the meantime
		pendingKey: null,
		offer: null,
	};
	// Documents whose banner was answered this page load: a later refresh must not offer the same draft again
	const resolved = new Set();

	const modeOn = () => Boolean(frappe.boot && frappe.boot.adhd_mode);
	const now = () => Date.now();
	const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
	const hasValue = (value) => value !== undefined && value !== null && value !== "";
	const isPlainValue = (value) => ["string", "number", "boolean"].includes(typeof value);
	const esc = (value) => frappe.utils.escape_html(value == null ? "" : String(value));

	function currentUser() {
		const user = frappe.session && frappe.session.user;
		return user && user !== "Guest" ? user : null;
	}

	// --- storage -------------------------------------------------------------------------------------------
	// Every access is guarded: private mode, blocked site data and a full quota all throw, and none of that
	// may show up as an error on the form.

	function getStorage() {
		try {
			return typeof localStorage === "undefined" ? null : localStorage;
		} catch {
			return null;
		}
	}

	function storageGet(key) {
		try {
			const store = getStorage();
			return store ? store.getItem(key) : null;
		} catch {
			return null;
		}
	}

	function storageSet(key, value) {
		try {
			const store = getStorage();
			if (!store) return false;
			store.setItem(key, value);
			return true;
		} catch {
			return false;
		}
	}

	function storageRemove(key) {
		try {
			const store = getStorage();
			if (store) store.removeItem(key);
		} catch {
			// nothing to remove from
		}
	}

	function storageKeys() {
		const keys = [];
		try {
			const store = getStorage();
			if (!store) return keys;
			for (let index = 0; index < store.length; index++) {
				const key = store.key(index);
				if (typeof key === "string" && key.startsWith(KEY_PREFIX)) keys.push(key);
			}
		} catch {
			// unreadable storage has no drafts to list
		}
		return keys;
	}

	// The signed-in user is part of the key: a snapshot holds customer names, prices and addresses, and
	// another person on the same browser must never be offered it.
	function userPrefix(user) {
		return `${KEY_PREFIX}${encodeURIComponent(user)}:`;
	}

	function keyFor(user, doctype, name) {
		return `${userPrefix(user)}${encodeURIComponent(doctype)}:${encodeURIComponent(name)}`;
	}

	// The key for the signed-in user, or null when nobody is
	function storageKey(doctype, name) {
		const user = currentUser();
		return user ? keyFor(user, doctype, name) : null;
	}

	function parseSnapshot(text) {
		try {
			const snapshot = JSON.parse(text);
			return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : null;
		} catch {
			return null;
		}
	}

	function isValidSnapshot(snapshot, user, doctype) {
		return Boolean(
			snapshot &&
				snapshot.v === SNAPSHOT_VERSION &&
				snapshot.user === user &&
				snapshot.doctype === doctype &&
				Number.isFinite(snapshot.savedAt) &&
				snapshot.scalars &&
				typeof snapshot.scalars === "object" &&
				snapshot.childTables &&
				typeof snapshot.childTables === "object"
		);
	}

	function isExpired(savedAt) {
		return !Number.isFinite(savedAt) || now() - savedAt > MAX_AGE_MS;
	}

	// Delete snapshots that are unreadable or older than a week (whoever they belong to: old customer data
	// should not linger), then keep this user's newest MAX_SNAPSHOTS_PER_USER. `keepKey` is never evicted.
	function purgeDraftSnapshots(user, keepKey) {
		try {
			const mine = user ? userPrefix(user) : null;
			const live = [];
			storageKeys().forEach((key) => {
				const snapshot = parseSnapshot(storageGet(key));
				if (!snapshot || isExpired(snapshot.savedAt)) {
					storageRemove(key);
				} else if (mine && key.startsWith(mine)) {
					live.push({ key, savedAt: snapshot.savedAt });
				}
			});
			live.sort(
				(a, b) => Number(b.key === keepKey) - Number(a.key === keepKey) || b.savedAt - a.savedAt
			);
			live.slice(MAX_SNAPSHOTS_PER_USER).forEach((entry) => storageRemove(entry.key));
		} catch {
			// housekeeping must never break the form
		}
	}

	function writeSnapshot(user, snapshot) {
		let text;
		try {
			text = JSON.stringify(snapshot);
		} catch {
			return false;
		}
		if (text.length > MAX_SNAPSHOT_CHARS) return false;

		const key = keyFor(user, snapshot.doctype, snapshot.docName);
		if (!storageSet(key, text)) {
			// out of space: make room by dropping expired drafts, and try once more
			purgeDraftSnapshots(user, key);
			if (!storageSet(key, text)) return false;
		}
		purgeDraftSnapshots(user, key);
		return true;
	}

	// The stored snapshot for a document, or null. A corrupt or expired one is removed on the way.
	function readSnapshot(user, doctype, name) {
		const key = keyFor(user, doctype, name);
		const text = storageGet(key);
		if (text === null || text === undefined) return null;
		const snapshot = parseSnapshot(text);
		if (!isValidSnapshot(snapshot, user, doctype) || isExpired(snapshot.savedAt)) {
			storageRemove(key);
			return null;
		}
		return snapshot;
	}

	// --- reading the form -----------------------------------------------------------------------------------

	const isDirty = (frm) =>
		typeof frm.is_dirty === "function" ? frm.is_dirty() : Boolean(frm.doc.__unsaved);
	const isNewDoc = (frm) => Boolean(typeof frm.is_new === "function" ? frm.is_new() : frm.doc.__islocal);
	const docKeyOf = (frm) => `${frm.doctype}::${frm.doc.name}`;

	function pickFields(source, fields) {
		const picked = {};
		fields.forEach((field) => {
			if (isPlainValue(source[field])) picked[field] = source[field];
		});
		return picked;
	}

	// The whitelisted fields of the form as plain data: no Frappe metadata, no computed totals.
	function buildContent(frm, config) {
		const scalars = pickFields(frm.doc, [...config.scalars, ...config.lateScalars]);
		const childTables = {};
		Object.entries(config.tables).forEach(([table, spec]) => {
			childTables[table] = (frm.doc[table] || [])
				.filter((row) => row && spec.identity.some((field) => hasValue(row[field])))
				.map((row) => pickFields(row, spec.fields));
		});
		return { scalars, childTables };
	}

	// A new form always counts as unsaved to Frappe, and its defaults (company, currency, dates) are filled in
	// on their own. It is worth a snapshot only once someone has picked a party or an item.
	function hasUserContent(config, content) {
		return (
			config.party.some((field) => hasValue(content.scalars[field])) ||
			(content.childTables.items || []).length > 0
		);
	}

	// Datetimes on a document are in the system time zone, not the browser's.
	function serverTimeMs(value) {
		if (!hasValue(value)) return NaN;
		const text = String(value);
		const zone = systemTimeZone();
		if (zone && typeof moment !== "undefined" && moment.tz) return moment.tz(text, zone).valueOf();
		return new Date(text.replace(" ", "T")).getTime();
	}

	// A snapshot may only be offered for a saved document if nothing has been saved since it was taken;
	// restoring it over a newer save would wipe that save.
	function isNewerThanDocument(snapshot, doc) {
		const modified = serverTimeMs(doc.modified);
		if (!Number.isFinite(modified)) return false;
		if (!(snapshot.savedAt > modified)) return false;
		// the version the snapshot was taken from must still be the one on screen
		if (snapshot.baseModified && doc.modified && snapshot.baseModified !== doc.modified) return false;
		return true;
	}

	// --- the snapshot loop ----------------------------------------------------------------------------------

	function writeFormSnapshot(frm) {
		const config = frm && SNAPSHOT_FIELDS[frm.doctype];
		if (!config || !frm.doc || !modeOn()) return false;
		if (Number(frm.doc.docstatus) !== 0) return false;
		const user = currentUser();
		if (!user || !isDirty(frm)) return false;
		if (state.pendingKey === docKeyOf(frm)) return false;
		// the form was switched to another document and has not been refreshed for it yet
		if (state.frm === frm && state.docname !== frm.doc.name) return false;

		const isNew = isNewDoc(frm);
		const content = buildContent(frm, config);
		if (isNew && !hasUserContent(config, content)) return false;

		const signature = JSON.stringify(content);
		const docKey = docKeyOf(frm);
		if (state.lastWrite && state.lastWrite.docKey === docKey && state.lastWrite.signature === signature) {
			return false;
		}

		const written = writeSnapshot(user, {
			v: SNAPSHOT_VERSION,
			user,
			doctype: frm.doctype,
			docName: isNew ? NEW_DOC_NAME : frm.doc.name,
			isNew,
			savedAt: now(),
			baseModified: isNew ? null : frm.doc.modified || null,
			...content,
		});
		if (written) state.lastWrite = { docKey, signature };
		return written;
	}

	// Writes one snapshot if the form qualifies. Never throws.
	function snapshotForm(frm) {
		try {
			return writeFormSnapshot(frm);
		} catch (error) {
			console.warn("[ADHD Draft Recovery] Could not snapshot the form", error);
			return false;
		}
	}

	function isShowingForm(frm) {
		const route = frappe.get_route && frappe.get_route();
		return Boolean(route && route[0] === "Form" && route[1] === frm.doctype);
	}

	function stopDraftAutosave() {
		if (state.timer) clearInterval(state.timer);
		state.timer = null;
		state.frm = null;
		state.docname = null;
		state.lastWrite = null;
	}

	function tick(frm) {
		if (!modeOn() || !isShowingForm(frm)) {
			stopDraftAutosave();
			return;
		}
		snapshotForm(frm);
	}

	// Starts (or keeps) the 30 second loop for the document on this form. Refreshing the same document again
	// leaves the running loop alone; another document starts a fresh one.
	function startDraftAutosave(frm) {
		if (!modeOn()) {
			stopDraftAutosave();
			return false;
		}
		if (!frm || !frm.doc || !SNAPSHOT_FIELDS[frm.doctype]) return false;
		if (Number(frm.doc.docstatus) !== 0 || !currentUser()) {
			if (state.frm === frm) stopDraftAutosave();
			return false;
		}
		if (state.timer && state.frm === frm && state.docname === frm.doc.name) return true;

		stopDraftAutosave();
		purgeDraftSnapshots(currentUser());
		state.frm = frm;
		state.docname = frm.doc.name;
		state.timer = setInterval(() => tick(frm), SNAPSHOT_INTERVAL_MS);
		return true;
	}

	// Removes the stored snapshot(s) of the document on this form. The nameless slot goes too when this form
	// was a new document a moment ago (`includeNew`), which the caller knows and this function cannot: once
	// the document is saved its local name is gone.
	function clearDraftSnapshot(frm, { includeNew = false } = {}) {
		try {
			const user = currentUser();
			if (!user || !frm || !frm.doctype) return;
			if (includeNew) storageRemove(keyFor(user, frm.doctype, NEW_DOC_NAME));
			if (frm.doc && frm.doc.name) storageRemove(keyFor(user, frm.doctype, frm.doc.name));
			state.lastWrite = null;
			dropOffer(frm);
		} catch {
			// nothing worth failing a save over
		}
	}

	// --- the "Resume it?" banner ----------------------------------------------------------------------------

	// `.form-layout`, a jQuery object: Layout sets `wrapper` (there is no `layout.$wrapper`), and Form sets `$wrapper`.
	function bannerRoot(frm) {
		return (frm && frm.layout && frm.layout.wrapper) || (frm && frm.$wrapper) || null;
	}

	function findBanner(frm) {
		const root = bannerRoot(frm);
		return root ? root.find(".adhd-restore-banner") : null;
	}

	function removeBanner(frm) {
		const $banner = findBanner(frm);
		if ($banner) $banner.remove();
	}

	function dropOffer(frm) {
		removeBanner(frm);
		if (frm && frm.doc && state.pendingKey === docKeyOf(frm)) state.pendingKey = null;
		state.offer = null;
	}

	function ageText(savedAt) {
		const seconds = Math.max(0, (now() - savedAt) / 1000);
		if (seconds < 60) return __("just now");
		if (seconds < 120) return __("1 minute ago");
		if (seconds < 3600) return __("{0} minutes ago", [Math.floor(seconds / 60)]);
		if (seconds < 7200) return __("1 hour ago");
		if (seconds < 86400) return __("{0} hours ago", [Math.floor(seconds / 3600)]);
		const days = Math.floor(seconds / 86400);
		return days === 1 ? __("yesterday") : __("{0} days ago", [days]);
	}

	// What is written on the banner comes from a stored snapshot, so all of it is escaped.
	function bannerHtml(frm, snapshot) {
		const config = SNAPSHOT_FIELDS[frm.doctype];
		const party = config.party.map((field) => snapshot.scalars[field]).find(hasValue);
		const itemCount = Array.isArray(snapshot.childTables.items) ? snapshot.childTables.items.length : 0;
		const details = [party ? String(party) : "", itemCount ? __("Items: {0}", [itemCount]) : ""]
			.filter(Boolean)
			.map(esc)
			.join(" · ");
		const message = __("Unsaved {0} draft found (last edited {1}). Resume it?", [
			__(frm.doctype),
			ageText(snapshot.savedAt),
		]);
		return `
			<div class="adhd-restore-banner" role="status">
				<span class="adhd-restore-text">
					${esc(message)}
					${details ? `<span class="adhd-restore-details">${details}</span>` : ""}
				</span>
				<button type="button" class="btn btn-xs btn-primary adhd-restore-btn">${esc(__("Restore"))}</button>
				<button type="button" class="btn btn-xs btn-default adhd-discard-btn">${esc(__("Discard"))}</button>
			</div>
		`;
	}

	function showRestoreBanner(frm, snapshot) {
		const root = bannerRoot(frm);
		if (!root) return false;

		const docKey = docKeyOf(frm);
		// the same offer is already on screen: nothing to redo
		const $existing = findBanner(frm);
		if (
			$existing &&
			$existing.length &&
			state.offer &&
			state.offer.docKey === docKey &&
			state.offer.savedAt === snapshot.savedAt
		) {
			return true;
		}

		// one banner at a time, whatever order the refreshes and the Smart Inbox hook arrive in
		removeBanner(frm);
		const $banner = $(bannerHtml(frm, snapshot));
		$banner.find(".adhd-restore-btn").on("click", () => onRestoreClick(frm, snapshot, docKey));
		$banner.find(".adhd-discard-btn").on("click", () => discardDraft(frm, snapshot, docKey));
		root.prepend($banner);
		state.pendingKey = docKey;
		state.offer = { docKey, savedAt: snapshot.savedAt };
		return true;
	}

	// Called on every refresh of a Sales Order or Quotation, from this file and from the Smart Inbox hook, so
	// it must be safe to repeat. Returns whether a banner is showing.
	function checkAndOfferDraftRestore(frm) {
		try {
			return offerDraftRestore(frm);
		} catch (error) {
			console.warn("[ADHD Draft Recovery] Could not offer the saved draft", error);
			return false;
		}
	}

	function offerDraftRestore(frm) {
		const config = frm && SNAPSHOT_FIELDS[frm.doctype];
		if (!config || !frm.doc) return false;

		const user = currentUser();
		if (!modeOn() || !user || Number(frm.doc.docstatus) !== 0 || resolved.has(docKeyOf(frm))) {
			dropOffer(frm);
			return false;
		}

		const isNew = isNewDoc(frm);
		const name = isNew ? NEW_DOC_NAME : frm.doc.name;
		const snapshot = readSnapshot(user, frm.doctype, name);
		if (!snapshot) {
			dropOffer(frm);
			return false;
		}

		if (isNew) {
			// a form that already has a party or items (opened from a Quotation, filled in by the assistant, or
			// typed into) is not a blank one: leave it alone
			if (hasUserContent(config, buildContent(frm, config))) {
				dropOffer(frm);
				return false;
			}
		} else if (isDirty(frm) || !isNewerThanDocument(snapshot, frm.doc)) {
			// unsaved edits are still on screen, or the document was saved after the snapshot was taken
			if (!isDirty(frm)) storageRemove(keyFor(user, frm.doctype, name));
			dropOffer(frm);
			return false;
		}

		return showRestoreBanner(frm, snapshot);
	}

	function markResolved(frm, docKey) {
		resolved.add(docKey);
		removeBanner(frm);
		if (state.pendingKey === docKey) state.pendingKey = null;
		state.offer = null;
		// the next tick takes a fresh snapshot of whatever is on the form
		state.lastWrite = null;
	}

	function discardDraft(frm, snapshot, docKey) {
		const user = currentUser();
		if (user) storageRemove(keyFor(user, snapshot.doctype, snapshot.docName));
		markResolved(frm, docKey);
	}

	function hasEditsToLose(frm) {
		const config = SNAPSHOT_FIELDS[frm.doctype];
		return isNewDoc(frm) ? hasUserContent(config, buildContent(frm, config)) : isDirty(frm);
	}

	function onRestoreClick(frm, snapshot, docKey) {
		const run = () => {
			markResolved(frm, docKey);
			return restoreDraft(frm, snapshot);
		};
		if (!hasEditsToLose(frm)) return run();
		// what the person typed since the banner appeared is about to be replaced: ask first
		return new Promise((resolve) => {
			frappe.confirm(
				__("Replace what is on this form with the saved draft?"),
				() => resolve(run()),
				() => resolve(false)
			);
		});
	}

	// --- restoring ------------------------------------------------------------------------------------------

	// Lets the fetches a field's handler started (party details, price list, taxes, ...) finish before the
	// next field is set, so they cannot overwrite it.
	function settle() {
		return frappe.after_ajax ? frappe.after_ajax() : Promise.resolve();
	}

	function restoreTable(frm, table, spec, rows) {
		if (!Array.isArray(rows) || !rows.length) return;
		frappe.model.clear_table(frm.doc, table);
		rows.forEach((data) => {
			if (!data || typeof data !== "object") return;
			const row = frappe.model.add_child(frm.doc, spec.doctype, table);
			// only fields this feature saved: a tampered snapshot cannot set the name, parent or docstatus
			spec.fields.forEach((field) => {
				if (hasOwn(data, field) && isPlainValue(data[field])) row[field] = data[field];
			});
		});
		frm.refresh_field(table);
	}

	// Puts a snapshot back on the form through the same calls the form uses: set_value for the fields (so the
	// form's own handlers run), add_child + refresh_field for the rows. The party goes first so its fetch does
	// not overwrite the rest, then the rest in the order of SNAPSHOT_FIELDS, then the child tables, then the
	// fields that recalculate totals. Returns whether it finished on the same document.
	async function restoreDraft(frm, snapshot) {
		const config = SNAPSHOT_FIELDS[frm.doctype];
		if (!config || !frm.doc || Number(frm.doc.docstatus) !== 0 || !modeOn()) return false;

		const startName = frm.doc.name;
		// the form object is reused across documents: never write onto a different one
		const stillHere = () => Boolean(frm.doc) && frm.doc.name === startName && modeOn();
		const setFields = async (fields) => {
			for (const field of fields) {
				if (!stillHere()) return false;
				const value = hasOwn(snapshot.scalars, field) ? snapshot.scalars[field] : undefined;
				if (!isPlainValue(value)) continue;
				if (frm.fields_dict && !frm.fields_dict[field]) continue;
				try {
					await frm.set_value(field, value);
					await settle();
				} catch (error) {
					console.warn(`[ADHD Draft Recovery] Could not restore ${field}`, error);
				}
			}
			return stillHere();
		};

		try {
			if (!(await setFields(config.scalars))) return false;
			Object.entries(config.tables).forEach(([table, spec]) => {
				if (stillHere()) restoreTable(frm, table, spec, snapshot.childTables[table]);
			});
			if (!(await setFields(config.lateScalars))) return false;

			const controller = frm.cscript;
			if (controller && typeof controller.calculate_taxes_and_totals === "function") {
				await controller.calculate_taxes_and_totals();
			}
			if (!isDirty(frm) && typeof frm.dirty === "function") frm.dirty();
		} catch (error) {
			console.warn("[ADHD Draft Recovery] Could not restore the whole draft", error);
			frappe.show_alert({ message: __("Could not restore the whole draft."), indicator: "orange" });
			return false;
		}

		frappe.show_alert({ message: __("{0} draft restored.", [__(frm.doctype)]), indicator: "green" });
		return true;
	}

	// --- wiring ---------------------------------------------------------------------------------------------

	function guarded(fn) {
		try {
			fn();
		} catch (error) {
			console.warn("[ADHD Draft Recovery]", error);
		}
	}

	RECOVERY_DOCTYPES.forEach((doctype) => {
		frappe.ui.form.on(doctype, {
			refresh(frm) {
				guarded(() => {
					if (Number(frm.doc.docstatus) !== 0) {
						// a submitted or cancelled document has no draft
						if (state.frm === frm) stopDraftAutosave();
						if (!isNewDoc(frm) && currentUser()) {
							storageRemove(keyFor(currentUser(), frm.doctype, frm.doc.name));
						}
						dropOffer(frm);
						return;
					}
					startDraftAutosave(frm);
					checkAndOfferDraftRestore(frm);
				});
			},
			// The save is about to make a new document a named one; after_save no longer knows it was new.
			before_save(frm) {
				guarded(() => {
					frm._adhdDraftWasNew = isNewDoc(frm);
				});
			},
			// A saved document is no longer a draft, so its snapshot is obsolete whether or not the mode is on.
			after_save(frm) {
				guarded(() => {
					clearDraftSnapshot(frm, { includeNew: Boolean(frm._adhdDraftWasNew) });
					frm._adhdDraftWasNew = false;
				});
			},
			// Frappe fires on_submit after the server accepted a submit; it never fires a client after_submit.
			on_submit(frm) {
				guarded(() => {
					if (state.frm === frm) stopDraftAutosave();
					clearDraftSnapshot(frm, { includeNew: Boolean(frm._adhdDraftWasNew) });
					frm._adhdDraftWasNew = false;
				});
			},
		});
	});

	// The mode can be switched off while a form is open: stop at once, and drop the banner.
	if (erpnext.adhd.onStateChange) {
		erpnext.adhd.onStateChange((active) => {
			guarded(() => {
				if (!active) {
					const frm = state.frm;
					stopDraftAutosave();
					if (frm) dropOffer(frm);
				} else if (window.cur_frm) {
					startDraftAutosave(window.cur_frm);
				}
			});
		});
	}

	// Leaving the form (another page, another document's list) stops the loop: nothing snapshots a form that
	// is not on screen.
	if (typeof $ === "function") {
		$(document).on("form-unload", (_event, frm) => {
			if (state.frm && state.frm === frm) stopDraftAutosave();
		});
	}
	if (frappe.router && typeof frappe.router.on === "function") {
		frappe.router.on("change", () => {
			if (state.frm && !isShowingForm(state.frm)) stopDraftAutosave();
		});
	}

	erpnext.adhd.draftRecovery = {
		RECOVERY_DOCTYPES,
		SNAPSHOT_FIELDS,
		NEW_DOC_NAME,
		SNAPSHOT_INTERVAL_MS,
		storageKey,
		snapshotForm,
		startDraftAutosave,
		stopDraftAutosave,
		clearDraftSnapshot,
		checkAndOfferDraftRestore,
		restoreDraft,
		purgeDraftSnapshots: () => purgeDraftSnapshots(currentUser()),
	};
	erpnext.adhd.checkAndOfferDraftRestore = checkAndOfferDraftRestore;
})();
