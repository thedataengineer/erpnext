// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
// For license information, please see license.txt

// The command bar: one wide box (⌘K / Ctrl+K) to search anything and to do anything, by typing or by
// talking. As you type it offers records, things to do, and "ask the assistant". Choosing something to
// do continues as a short conversation right under the box, using the same draft-and-confirm flow as the
// chat panel, so nothing is saved until you confirm.

frappe.provide("erpnext.assistant");

erpnext.assistant.Bar = class Bar {
	constructor(chat) {
		this.chat = chat;
		this.mode = "search"; // "search" while typing, "convo" while talking to the assistant
		this.rows = []; // the selectable rows on screen
		this.index = 0;
		this.first = null; // the empty-query view, kept so reopening is instant
		this.seq = 0; // drops answers to searches that are no longer current
		this.timer = null;
		this.listening = false;
		this._render();
		this._bind();
		this._setupVoice();
		chat.onChange(() => this._onChat());
	}

	// --- setup ---

	_render() {
		const icon = (name, size = "md") => frappe.utils.icon(name, size);
		this.$backdrop = $(`
			<div class="erp-bar-backdrop" hidden>
				<section class="erp-bar" role="dialog" aria-modal="true" aria-label="${__("Search or ask anything")}">
					<div class="erp-bar-input">
						<span class="erp-bar-icon">${icon("search")}</span>
						<div class="erp-bar-field">
							<div class="erp-bar-ghost" aria-hidden="true"><span class="typed"></span><span class="rest"></span></div>
							<input type="text" role="combobox" aria-expanded="true" aria-controls="erp-bar-list"
								aria-autocomplete="list" autocomplete="off" autocapitalize="off" spellcheck="false"
								aria-label="${__("Search or ask anything")}">
						</div>
						<button type="button" class="erp-bar-mic" aria-pressed="false" aria-label="${__("Talk")}"
							title="${__("Talk instead of typing")}">${icon("mic")}</button>
						<kbd class="erp-bar-esc">esc</kbd>
					</div>
					<div class="erp-bar-note" role="status" hidden></div>
					<div class="erp-bar-body" id="erp-bar-list" role="listbox" aria-label="${__("Results")}"></div>
					<footer class="erp-bar-foot">
						<span><kbd>↑</kbd><kbd>↓</kbd> ${__("move")}</span>
						<span><kbd>↵</kbd> ${__("choose")}</span>
						<span><kbd>Tab</kbd> ${__("complete")}</span>
						<span class="erp-bar-foot-mode"></span>
						<button type="button" class="erp-bar-chat btn btn-xs btn-default">${__("Open as chat")}</button>
					</footer>
				</section>
			</div>`).appendTo(document.body);

		this.$bar = this.$backdrop.find(".erp-bar");
		this.$input = this.$backdrop.find("input");
		this.$ghostTyped = this.$backdrop.find(".erp-bar-ghost .typed");
		this.$ghostRest = this.$backdrop.find(".erp-bar-ghost .rest");
		this.$body = this.$backdrop.find(".erp-bar-body");
		this.$note = this.$backdrop.find(".erp-bar-note");
		this.$mic = this.$backdrop.find(".erp-bar-mic");
		this._placeholder();
	}

	_placeholder() {
		this.$input.attr(
			"placeholder",
			this.mode === "convo"
				? __("Reply here, or press Esc to search again")
				: __("Search anything, or tell me what to do…")
		);
		this.$backdrop
			.find(".erp-bar-foot-mode")
			.text(this.mode === "convo" ? __("Esc: back to search") : __("Esc: close"));
	}

	_bind() {
		this.$backdrop.on("mousedown", (e) => {
			if (e.target === this.$backdrop[0]) this.close();
		});
		this.$input.on("input", () => this._onType());
		this.$input.on("keydown", (e) => this._onKey(e));
		this.$mic.on("click", () => this._toggleVoice());
		this.$backdrop.find(".erp-bar-chat").on("click", () => {
			this.close();
			this.chat.show();
		});

		this.$body.on("mousemove", ".erp-bar-row", (e) => {
			const i = Number($(e.currentTarget).data("idx"));
			if (i !== this.index) this._highlight(i, false);
		});
		this.$body.on("click", ".erp-bar-row", (e) => {
			this.index = Number($(e.currentTarget).data("idx"));
			this._activate(this.rows[this.index]);
		});
		// conversation results reuse the chat panel's chips, card buttons and links
		this.$body.on("click", "[data-chip]", (e) => this.chat.chip(Number($(e.currentTarget).data("chip"))));
		this.$body.on("click", "[data-card]", (e) => {
			const kind = $(e.currentTarget).data("card");
			this.chat.cardAction(kind);
			if (kind === "open") this.close();
		});
		this.$body.on("click", "[data-route]", (e) => {
			e.preventDefault();
			frappe.set_route(JSON.parse($(e.currentTarget).attr("data-route")));
			this.close();
		});

		// ⌘K / Ctrl+K anywhere. Frappe already uses it for its own search, so this runs first (capture phase);
		// its search stays on Ctrl+G. Rich-text editors keep ⌘K for "insert link".
		document.addEventListener(
			"keydown",
			(e) => {
				if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k")
					return;
				if (
					e.target.closest &&
					e.target.closest(".ql-editor, .ace_editor, .CodeMirror, .note-editable")
				)
					return;
				e.preventDefault();
				e.stopImmediatePropagation();
				this.toggle();
			},
			true
		);
	}

	// --- opening and closing ---

	get isOpen() {
		return !this.$backdrop.prop("hidden");
	}

	toggle() {
		this.isOpen ? this.close() : this.open();
	}

	open() {
		this.mode = "search";
		this._placeholder();
		this.$backdrop.prop("hidden", false);
		document.body.classList.add("erp-bar-open");
		this.$input.val("").trigger("focus");
		this._ghost();
		if (this.first) this._paintSearch(this.first); // instant, then refreshed
		this._search("");
		if (!this.chat.checkedStatus) this.chat._checkStatus();
		this._showNotice(this.chat.modelNotice);
	}

	close() {
		if (this.listening) this.rec.stop();
		this.$backdrop.prop("hidden", true);
		document.body.classList.remove("erp-bar-open");
		this.$note.prop("hidden", true);
	}

	// --- typing ---

	_onType() {
		this._ghost();
		if (this.mode !== "search") return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this._search(this.$input.val().trim()), 110);
	}

	async _search(text) {
		const seq = ++this.seq;
		try {
			const args = { query: text };
			const context = erpnext.assistant.view.currentContext();
			if (context) args.context = JSON.stringify(context);
			const { message } = await frappe.call({
				method: `${erpnext.assistant.API}.search`,
				args,
				no_spinner: true,
			});
			if (seq !== this.seq || this.mode !== "search") return; // a newer keystroke won
			if (!text) this.first = message;
			this._paintSearch(message);
		} catch (e) {
			if (seq === this.seq) {
				this.$body.html(
					`<div class="erp-bar-empty">${__("Search isn't available right now.")}</div>`
				);
			}
		}
	}

	_onKey(e) {
		if (e.isComposing) return;
		const value = this.$input.val().trim();
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (this.mode === "search" && this.rows.length) {
				this._highlight(
					(this.index + (e.key === "ArrowDown" ? 1 : -1) + this.rows.length) % this.rows.length
				);
			}
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (this.mode === "convo") {
				this._sendFollowUp(value);
			} else if ((e.metaKey || e.ctrlKey) && value) {
				this._activate({ type: "ask", text: value, title: value }); // ⌘↵: hand the sentence to the assistant
			} else if (this.rows[this.index]) {
				this._activate(this.rows[this.index]);
			} else if (value) {
				this._activate({ type: "ask", text: value, title: value });
			}
		} else if (e.key === "Tab" && !e.shiftKey && this.mode === "search" && this.completion) {
			e.preventDefault();
			this.$input.val(this.completion);
			this._onType();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			this.mode === "convo" ? this._backToSearch() : this.close();
		}
	}

	// grey "type-ahead" text: the rest of the highlighted result's name
	_ghost() {
		const typed = this.$input.val();
		const row = this.mode === "search" ? this.rows[this.index] : null;
		// an email's subject is written by a stranger: never offer it as text to complete into the box, where
		// pressing Enter would send it to the model as if the person had typed it
		const isMail = row && Array.isArray(row.route) && row.route[1] === "Communication";
		const title = row && row.type !== "ask" && !isMail ? row.title : "";
		this.completion = "";
		let rest = "";
		if (
			typed &&
			title &&
			title.toLowerCase().startsWith(typed.toLowerCase()) &&
			title.length > typed.length
		) {
			rest = title.slice(typed.length);
			this.completion = title; // complete to the record's own spelling, not the case that was typed
		}
		this.$ghostTyped.text(typed);
		this.$ghostRest.text(rest);
	}

	// --- search results ---

	_paintSearch(result) {
		this.rows = [];
		const sections = [];
		const add = (row) => {
			row.id = `erp-bar-opt-${this.rows.length}`;
			this.rows.push(row);
			return row;
		};
		const ask = result.ask
			? { type: "ask", title: result.ask.text, hint: __("Ask the assistant"), text: result.ask.text }
			: null;

		if (ask && result.ask.primary) sections.push({ label: __("Do it"), rows: [add(ask)] });
		if (result.actions.length) {
			sections.push({
				label: result.query ? __("Do") : __("Do next"),
				rows: result.actions.map((a) =>
					add({ type: "action", title: a.label, hint: a.hint, action: a.action })
				),
			});
		}
		result.groups.forEach((g) =>
			sections.push({
				label: g.label,
				rows: g.items.map((i) =>
					add({
						type: g.doctype ? "record" : "page",
						title: i.title,
						hint: i.subtitle,
						route: i.route,
					})
				),
			})
		);
		if (ask && !result.ask.primary) sections.push({ label: __("Or ask"), rows: [add(ask)] });

		this.index = 0;
		this.$body.html(
			sections.length
				? sections.map((s) => this._sectionHtml(s)).join("")
				: `<div class="erp-bar-empty">${__("Type a name to find it, or tell me what to do.")}</div>`
		);
		this.$input.attr("aria-activedescendant", this.rows[0] ? this.rows[0].id : "");
		this._ghost();
		this._announce(result);
	}

	_sectionHtml(section) {
		const esc = erpnext.assistant.view.esc;
		const icons = {
			action: "sparkles",
			ask: "message-circle",
			record: "arrow-up-right",
			page: "arrow-up-right",
		};
		const rows = section.rows
			.map((row) => {
				const idx = this.rows.indexOf(row);
				return `<div class="erp-bar-row${idx === this.index ? " is-active" : ""}" role="option" id="${
					row.id
				}"
					data-idx="${idx}" data-type="${row.type}" aria-selected="${idx === this.index}">
					<span class="ic">${frappe.utils.icon(icons[row.type], "sm")}</span>
					<span class="t">${esc(row.type === "ask" ? `“${row.title}”` : row.title)}</span>
					<span class="h">${esc(row.hint || "")}</span>
					<span class="go">↵</span>
				</div>`;
			})
			.join("");
		return `<div class="erp-bar-section"><div class="erp-bar-label">${esc(
			section.label
		)}</div>${rows}</div>`;
	}

	_highlight(i, scroll = true) {
		this.index = i;
		this.$body.find(".erp-bar-row").each((n, el) => {
			const active = n === i;
			el.classList.toggle("is-active", active);
			el.setAttribute("aria-selected", active);
			if (active && scroll) el.scrollIntoView({ block: "nearest" });
		});
		this.$input.attr("aria-activedescendant", this.rows[i] ? this.rows[i].id : "");
		this._ghost();
	}

	_announce(result) {
		const n = result.groups.reduce((sum, g) => sum + g.items.length, 0) + result.actions.length;
		this.$note.attr("aria-label", __("{0} results", [n]));
	}

	// --- choosing ---

	_activate(row) {
		if (!row) return;
		// Only the kind of action goes into the usage log ("create_lead"), never what the person typed:
		// row.action also carries the values extracted from their sentence (names, emails, notes).
		window.ADHDTelemetry?.emit({
			event_type: "command_intent",
			intent: (row.action && (row.action.recipe || row.action.type)) || row.type,
		});
		if (row.type === "record" || row.type === "page") {
			frappe.set_route(row.route);
			this.close();
		} else if (row.type === "action") {
			this._enterConvo();
			this.chat.run(row.action, row.title);
		} else if (row.type === "ask") {
			this._enterConvo();
			this.chat.send(row.text);
		}
	}

	// --- talking to the assistant, right under the box ---

	_enterConvo() {
		this.mode = "convo";
		clearTimeout(this.timer);
		this.seq++;
		this.$input.val("");
		this._placeholder();
		this._ghost();
		this._paintConvo();
	}

	_backToSearch() {
		this.mode = "search";
		this.$input.val("");
		this._placeholder();
		if (this.first) this._paintSearch(this.first);
		this._search("");
	}

	_sendFollowUp(text) {
		if (!text) return;
		this.$input.val("");
		this.chat.send(text);
	}

	_onChat() {
		if (!this.isOpen) return;
		if (this.mode === "convo") this._paintConvo();
		else if (!this.listening) this._showNotice(this.chat.modelNotice);
	}

	_paintConvo() {
		const view = erpnext.assistant.view;
		const chat = this.chat;
		const you = [...chat.messages].reverse().find((m) => m.role === "user");
		const bot = chat.latestBot();
		let html = you ? `<div class="erp-bar-you">${view.esc(you.text)}</div>` : "";
		if (chat.busy) {
			html += `<div class="erp-assistant-typing" aria-label="${__("Thinking")}">
				<span class="dots"><i></i><i></i><i></i></span>
				<span class="label">${view.esc(chat.typingLabel)}</span></div>`;
		} else if (bot) {
			html += view.messageHtml(bot, true);
		}
		this.$body.html(`<div class="erp-bar-convo">${html}</div>`);
		this.rows = [];
	}

	_showNotice(text) {
		this.$note.text(text || "").prop("hidden", !text);
	}

	// --- voice ---
	// Uses the browser's own speech recognition. In Chrome and Safari that can send the audio to the browser
	// vendor's service, so the bar says so while it listens. Everything else stays on this machine.

	_setupVoice() {
		const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!Recognition) {
			this.$mic.prop("hidden", true);
			return;
		}
		this.rec = new Recognition();
		this.rec.interimResults = true; // words appear (and search) as you speak
		this.rec.continuous = false;
		this.rec.lang = ((frappe.boot && frappe.boot.lang) || "en").replace("_", "-");
		this.rec.onresult = (e) => {
			const heard = Array.from(e.results)
				.map((r) => r[0].transcript)
				.join(" ")
				.trim();
			this.$input.val(heard);
			this._onType();
		};
		this.rec.onend = () => this._voice(false);
		this.rec.onerror = (e) => {
			this._voice(false);
			const messages = {
				"not-allowed": __("Microphone access is blocked for this site."),
				"service-not-allowed": __("Microphone access is blocked for this site."),
				"no-speech": __("Didn't catch anything. Try again."),
			};
			this._showNotice(messages[e.error] || __("Voice input isn't available ({0}).", [e.error]));
		};
	}

	_toggleVoice() {
		if (!this.rec) return;
		if (this.listening) {
			this.rec.stop();
			return;
		}
		try {
			this.rec.start();
			this._voice(true);
		} catch (e) {
			/* already listening */
		}
	}

	_voice(on) {
		this.listening = on;
		this.$mic.toggleClass("is-listening", on).attr("aria-pressed", on);
		this.$input.trigger("focus");
		this._showNotice(
			on
				? __(
						"Listening… Your browser's speech recognition may send audio to its vendor. Nothing else leaves this machine."
				  )
				: this.chat.modelNotice
		);
		if (!on) this._onType();
	}
};

$(document).on("app_ready", () => {
	if (frappe.session.user === "Guest" || erpnext.assistant.chat) return;
	erpnext.assistant.chat = new erpnext.assistant.Chat();
	erpnext.assistant.bar = new erpnext.assistant.Bar(erpnext.assistant.chat);
});
