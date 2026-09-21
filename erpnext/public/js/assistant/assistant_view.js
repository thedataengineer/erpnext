// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
// For license information, please see license.txt

// The pieces of a reply, drawn the same way in the chat panel and in the command bar:
// the message, result rows, the draft card, tap-to-answer suggestions.

frappe.provide("erpnext.assistant");

erpnext.assistant.API = "erpnext.assistant.api";

erpnext.assistant.view = {
	esc(text) {
		return frappe.utils.escape_html(text == null ? "" : String(text));
	},

	messageHtml(m, live) {
		const v = erpnext.assistant.view;
		if (m.role === "user") {
			return `<div class="erp-assistant-msg is-user">${v.esc(m.text)}</div>`;
		}
		const parts = [
			`<div class="erp-assistant-msg is-bot${m.error ? " is-error" : ""}">${v.esc(
				m.text || m.reply
			)}</div>`,
		];
		if (m.items && m.items.length) parts.push(v.itemsHtml(m.items));
		if (m.card) parts.push(v.cardHtml(m.card, live));
		if (m.created) parts.push(v.createdHtml(m.created));
		if (live && m.chips && m.chips.length) parts.push(v.chipsHtml(m.chips));
		return parts.join("");
	},

	chipsHtml(chips) {
		const v = erpnext.assistant.view;
		const buttons = chips
			.map(
				(c, i) =>
					`<button type="button" class="erp-assistant-chip" data-chip="${i}">${v.esc(
						c.label
					)}</button>`
			)
			.join("");
		return `<div class="erp-assistant-chips">${buttons}</div>`;
	},

	itemsHtml(items) {
		const v = erpnext.assistant.view;
		const rows = items
			.map((item) => {
				const inner = `<span class="label">${v.esc(item.label)}</span>
					${item.meta ? `<span class="meta">${v.esc(item.meta)}</span>` : ""}`;
				const cls = `erp-assistant-item ${item.tone ? `is-${v.esc(item.tone)}` : ""}`;
				return item.route
					? `<a href="#" class="${cls}" data-route='${v.esc(
							JSON.stringify(item.route)
					  )}'>${inner}</a>`
					: `<div class="${cls}">${inner}</div>`;
			})
			.join("");
		return `<div class="erp-assistant-items">${rows}</div>`;
	},

	createdHtml(created) {
		const v = erpnext.assistant.view;
		return `<a href="#" class="erp-assistant-created" data-route='${v.esc(
			JSON.stringify(created.route)
		)}'>
			${v.esc(__("Open {0}", [`${__(created.doctype)} ${created.name}`]))} &rarr;</a>`;
	},

	cardHtml(card, live) {
		const v = erpnext.assistant.view;
		const flags = {
			missing: __("needed"),
			ambiguous: __("which one?"),
			none: __("not found"),
			invalid: __("unclear"),
		};
		const rows = card.rows
			.map(
				(r) => `<div class="erp-assistant-row is-${v.esc(r.status)}">
					<span class="k">${v.esc(r.label)}</span>
					<span class="v">${v.esc(r.value) || "&mdash;"}
						${flags[r.status] ? `<em>${flags[r.status]}</em>` : ""}
						${r.note ? `<small>${v.esc(r.note)}</small>` : ""}</span>
				</div>`
			)
			.join("");
		const problems = (card.problems || [])
			.map((p) => `<div class="erp-assistant-problem">${v.esc(p)}</div>`)
			.join("");
		const off = live ? "" : " disabled";
		return `<div class="erp-assistant-card${live ? "" : " is-stale"}">
			<div class="erp-assistant-card-title">${v.esc(card.title)}</div>
			${rows}${problems}
			<div class="erp-assistant-card-actions">
				${
					// a form-only card (connecting a mailbox) has nothing safe to create from here: its password is typed in the form
					card.form_only
						? ""
						: `<button type="button" class="btn btn-primary btn-xs" data-card="create"
							${live && card.ready ? "" : "disabled"}>${__("Create")}</button>`
				}
				<button type="button" class="btn btn-${
					card.form_only ? "primary" : "default"
				} btn-xs" data-card="open"${off}>${
			card.form_only ? __("Open the form") : __("Open in form")
		}</button>
				<button type="button" class="btn btn-default btn-xs" data-card="discard"${off}>${__("Discard")}</button>
			</div>
		</div>`;
	},

	// Open the full form with what has been gathered so far filled in.
	openInForm(card) {
		const prefill = card.prefill || {};
		frappe.model.with_doctype(card.doctype, () => {
			const doc = frappe.model.get_new_doc(card.doctype);
			Object.entries(prefill).forEach(([field, value]) => {
				if (Array.isArray(value)) {
					value.forEach((row) => frappe.model.add_child(doc, field, row));
				} else {
					doc[field] = value;
				}
			});
			frappe.set_route("Form", card.doctype, doc.name);
		});
	},

	// Which record is the person looking at? "Log a call" on Acme's page means Acme.
	currentContext() {
		const route = (frappe.get_route && frappe.get_route()) || [];
		if (route[0] !== "Form" || !route[1] || !route[2]) return null;
		// frappe.get_route() has already decoded each part (router.js decode_component): decoding again
		// throws on a name like "Summer 50% off" and quietly changes one like "A%20B"
		const name = String(route[2]);
		// a document that is not saved yet is a local one; the "new-" prefix is only Frappe's naming habit
		const doc = frappe.get_doc && frappe.get_doc(route[1], name);
		const unsaved = doc ? Boolean(doc.__islocal) : name.startsWith("new-");
		return unsaved ? null : { doctype: route[1], name };
	},
};
