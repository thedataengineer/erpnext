// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
// For license information, please see license.txt

// Assistant: a chat panel that turns plain sentences into validated draft records, so people
// don't have to fill in pages of forms. A local language model (Ollama) understands the
// sentence; the server checks it and saves nothing until the person confirms.
//
// This class owns the conversation (messages + the server-side draft state). The command bar
// (assistant_bar.js) is a second front door to the same conversation.

frappe.provide("erpnext.assistant");

erpnext.assistant.STORAGE_KEY = "erpnext_assistant_session";
erpnext.assistant.MAX_MESSAGES = 30;

erpnext.assistant.Chat = class Chat {
	constructor() {
		this.messages = [];
		this.state = null;
		this.busy = false;
		this.checkedStatus = false;
		this.typingLabel = "";
		this.listeners = [];
		this._restore();
		this._render();
		this._bind();
	}

	// --- setup ---

	_render() {
		this.$fab = $(`
			<button class="erp-assistant-fab" type="button" aria-expanded="false"
				aria-label="${__("Search or ask anything")}" title="${__("Search or ask anything")} (⌘K)">
				${frappe.utils.icon("message-circle", "md")}
			</button>`).appendTo(document.body);

		this.$panel = $(`
			<section class="erp-assistant" role="dialog" aria-label="${__("Assistant")}" hidden>
				<header class="erp-assistant-head">
					<div>
						<div class="erp-assistant-title">${__("Assistant")}</div>
						<div class="erp-assistant-sub">${__("Tell me what you did. I'll fill in the form.")}</div>
					</div>
					<button class="erp-assistant-reset btn btn-xs btn-default" type="button"
						title="${__("Start over")}">${__("New chat")}</button>
					<button class="erp-assistant-close btn btn-xs btn-default" type="button"
						aria-label="${__("Close")}">&times;</button>
				</header>
				<div class="erp-assistant-notice" hidden></div>
				<div class="erp-assistant-log" role="log" aria-live="polite"></div>
				<form class="erp-assistant-form">
					<textarea rows="1" maxlength="1000" aria-label="${__("Message")}"
						placeholder="${__("e.g. 2h on the Acme redesign")}"></textarea>
					<button class="btn btn-primary btn-sm" type="submit">${__("Send")}</button>
				</form>
			</section>`).appendTo(document.body);

		this.$log = this.$panel.find(".erp-assistant-log");
		this.$input = this.$panel.find("textarea");
		this._paint();
	}

	_bind() {
		// the round button opens the command bar when there is one, otherwise this panel
		this.$fab.on("click", () => (erpnext.assistant.bar ? erpnext.assistant.bar.toggle() : this.toggle()));
		this.$panel.find(".erp-assistant-close").on("click", () => this.hide());
		this.$panel.find(".erp-assistant-reset").on("click", () => this.reset());

		this.$panel.find("form").on("submit", (e) => {
			e.preventDefault();
			this.submitInput();
		});
		this.$input.on("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.submitInput();
			}
		});
		this.$input.on("input", () => this._grow());

		this.$panel.on("keydown", (e) => {
			if (e.key === "Escape") this.hide();
		});

		// chips, card buttons and result rows are all handled here
		this.$log.on("click", "[data-chip]", (e) => this.chip(Number($(e.currentTarget).data("chip"))));
		this.$log.on("click", "[data-card]", (e) => this.cardAction($(e.currentTarget).data("card")));
		this.$log.on("click", "[data-route]", (e) => {
			e.preventDefault();
			frappe.set_route(JSON.parse($(e.currentTarget).attr("data-route")));
			if (window.matchMedia("(max-width: 768px)").matches) this.hide();
		});

		$(document).on("keydown", (e) => {
			// event.code, not event.key: on macOS Option changes the key (Option+J types "∆"), so a key
			// check never matches there
			if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyJ") {
				e.preventDefault();
				this.toggle();
			}
		});
	}

	// --- opening and closing ---

	toggle() {
		this.$panel.prop("hidden") ? this.show() : this.hide();
	}

	show() {
		this.$panel.prop("hidden", false);
		this._scroll();
		this.$input.trigger("focus");
		this.ensureStarted();
	}

	hide() {
		this.$panel.prop("hidden", true);
		this.$fab.trigger("focus");
	}

	// checks the model once and greets a brand-new conversation
	ensureStarted() {
		if (!this.checkedStatus) this._checkStatus();
		if (!this.messages.length && !this.busy) this._turn({ message: "hi" }, { silent: true });
	}

	reset() {
		this.messages = [];
		this.state = null;
		this._persist();
		this._paint();
		this._turn({ message: "hi" }, { silent: true });
	}

	async _checkStatus() {
		this.checkedStatus = true;
		const $notice = this.$panel.find(".erp-assistant-notice");
		try {
			const { message } = await frappe.call({
				method: `${erpnext.assistant.API}.status`,
				no_spinner: true,
			});
			const status = message || {};
			this.modelNotice = status.ok ? "" : status.message || __("The local model isn't available.");
			$notice.prop("hidden", !!status.ok).text(this.modelNotice);
			this._notify();
		} catch (e) {
			this.checkedStatus = false;
		}
	}

	// --- what the front doors call ---

	onChange(fn) {
		this.listeners.push(fn);
	}

	latestBot() {
		return [...this.messages].reverse().find((m) => m.role === "bot");
	}

	submitInput() {
		this.send(this.$input.val());
	}

	send(text) {
		text = (text || "").trim();
		if (!text || this.busy) return;
		this.$input.val("");
		this._grow();
		this.messages.push({ role: "user", text });
		this._turn({ message: text });
	}

	// a tapped suggestion from the search list ("New lead"): structured, so it never needs the model
	run(action, label) {
		if (this.busy) return;
		this.messages.push({ role: "user", text: label });
		this._turn({ action });
	}

	chip(index) {
		if (this.busy) return;
		const bot = this.latestBot();
		const chip = bot && bot.chips && bot.chips[index];
		if (chip) this.run(chip.action, chip.label);
	}

	cardAction(kind) {
		if (this.busy) return;
		const card = (this.latestBot() || {}).card;
		if (!card) return;
		if (kind === "create") {
			this.messages.push({ role: "user", text: __("Create") });
			this._turn({ create: true });
		} else if (kind === "discard") {
			this._turn({ action: { type: "discard" } });
		} else if (kind === "open") {
			erpnext.assistant.view.openInForm(card);
		}
	}

	async _turn(request, { silent = false } = {}) {
		this.busy = true;
		this.typingLabel = "";
		this._paint();
		const slow = setTimeout(() => this._typing(__("Waking up the local model…")), 6000);

		try {
			const method = request.create ? "create" : "chat";
			const args = { state: JSON.stringify(this.state || {}) };
			if (request.message) args.message = request.message;
			if (request.action) args.action = JSON.stringify(request.action);
			const context = erpnext.assistant.view.currentContext();
			if (context && method === "chat") args.context = JSON.stringify(context);

			const { message: reply } = await frappe.call({
				method: `${erpnext.assistant.API}.${method}`,
				type: "POST",
				args,
				no_spinner: true,
			});
			this.state = reply.state;
			this.messages.push({ role: "bot", ...reply });
			if (reply.created) this._announce(reply.created);
		} catch (e) {
			if (!silent) {
				this.messages.push({
					role: "bot",
					text: __("Something went wrong. Please try again."),
					error: true,
				});
			}
		} finally {
			clearTimeout(slow);
			this.busy = false;
			this.messages = this.messages.slice(-erpnext.assistant.MAX_MESSAGES);
			this._persist();
			this._paint();
		}
	}

	_announce(created) {
		const link = frappe.utils.get_form_link(created.doctype, created.name, true);
		frappe.show_alert({ message: `${__("Saved")} ${link}`, indicator: "green" }, 5);
	}

	// --- drawing ---

	_grow() {
		const el = this.$input[0];
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
	}

	_scroll() {
		this.$log.scrollTop(this.$log[0].scrollHeight);
	}

	_typing(text) {
		this.typingLabel = text;
		this.$log.find(".erp-assistant-typing .label").text(text);
		this._notify();
	}

	_notify() {
		this.listeners.forEach((fn) => fn(this));
	}

	_paint() {
		const view = erpnext.assistant.view;
		const latest = this.latestBot();
		const html = this.messages.map((m) => view.messageHtml(m, m === latest && !this.busy)).join("");
		const typing = this.busy
			? `<div class="erp-assistant-typing" aria-label="${__("Thinking")}">
				<span class="dots"><i></i><i></i><i></i></span><span class="label"></span></div>`
			: "";
		this.$log.html(html + typing);
		this.$panel.find("button[type=submit]").prop("disabled", this.busy);
		this._scroll();
		this._notify();
	}

	// --- remembering the conversation for this browser tab only ---

	_persist() {
		try {
			// cards carry prefill data, which is not needed once a message is no longer the latest
			const slim = this.messages.map((m, i) =>
				i === this.messages.length - 1
					? m
					: { ...m, card: m.card && { ...m.card, prefill: null }, chips: null }
			);
			sessionStorage.setItem(
				erpnext.assistant.STORAGE_KEY,
				JSON.stringify({ messages: slim, state: this.state })
			);
		} catch (e) {
			/* private mode or storage full: the chat still works, it just won't survive a reload */
		}
	}

	_restore() {
		try {
			const saved = JSON.parse(sessionStorage.getItem(erpnext.assistant.STORAGE_KEY) || "null");
			if (saved && Array.isArray(saved.messages)) {
				this.messages = saved.messages;
				this.state = saved.state || null;
			}
		} catch (e) {
			this.messages = [];
		}
	}
};
