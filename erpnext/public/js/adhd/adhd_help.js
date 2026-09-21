// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors

frappe.provide("erpnext.adhd");

(() => {
	// Only shortcuts that something handles: Alt+A (adhd_mode.js), Alt+J (assistant_chat.js), Ctrl/Cmd+K
	// (assistant_bar.js), and the Frappe desk ones (ui/keyboard.js, ui/sidebar/sidebar.js, form/form.js,
	// form/toolbar.js, list/list_view.js).
	const SHORTCUTS = [
		{ context: "Focus Mode", key: "Alt+A", description: "Toggle Focus mode" },
		{ context: "Focus Mode", key: "Alt+Shift+/", description: "Open this shortcut reference" },
		{ context: "Assistant", key: "Alt+J", description: "Open the assistant chat" },
		{ context: "Assistant", key: "Ctrl/Cmd+K", description: "Open the command bar" },
		{ context: "Global", key: "Ctrl+G", description: "Open global search" },
		{ context: "Global", key: "Ctrl+S", description: "Save (trigger the primary action)" },
		{ context: "Global", key: "Ctrl+/", description: "Toggle the sidebar" },
		{ context: "Global", key: "Shift+/", description: "Show all Frappe keyboard shortcuts" },
		{ context: "List View", key: "Ctrl+B", description: "Create a new document" },
		{ context: "List View", key: "↑/↓", description: "Move between rows" },
		{ context: "List View", key: "Shift+↑/↓", description: "Select multiple rows" },
		{ context: "List View", key: "Space", description: "Select the focused row" },
		{ context: "List View", key: "Enter", description: "Open the focused row" },
		{ context: "Form", key: "Ctrl+S", description: "Save" },
		{ context: "Form", key: "Ctrl+Z", description: "Undo the last action" },
		{ context: "Form", key: "Ctrl+Y", description: "Redo the last action" },
		{ context: "Form", key: "Ctrl+E", description: "Email the document" },
		{ context: "Form", key: "Ctrl+P", description: "Print the document" },
		{ context: "Form", key: "Ctrl+B", description: "Create a new document" },
		{ context: "Form", key: "Ctrl+J", description: "Jump to a field" },
		{ context: "Form", key: "Ctrl+Shift+>", description: "Go to the next record" },
		{ context: "Form", key: "Ctrl+Shift+<", description: "Go to the previous record" },
	];

	const escape = (value) => frappe.utils.escape_html(String(value));

	function renderShortcuts(shortcuts, term = "") {
		if (!shortcuts.length) {
			return `<p class="adhd-help-empty">${__("No shortcuts match '{0}'", [escape(term)])}</p>`;
		}
		const groups = shortcuts.reduce((result, shortcut) => {
			(result[shortcut.context] ||= []).push(shortcut);
			return result;
		}, {});
		return Object.entries(groups)
			.map(
				([context, items]) => `
				<section class="adhd-help-group">
					<h3 class="adhd-help-group-title">${escape(__(context))}</h3>
					<table class="adhd-help-table"><tbody>
						${items
							.map(
								(item) =>
									`<tr><td class="adhd-help-key"><kbd>${escape(
										item.key
									)}</kbd></td><td>${escape(__(item.description))}</td></tr>`
							)
							.join("")}
					</tbody></table>
				</section>`
			)
			.join("");
	}

	function closeHelpModal() {
		document.querySelector(".adhd-help-modal-overlay")?.remove();
	}

	function openHelpModal() {
		const existing = document.querySelector(".adhd-help-modal-overlay");
		if (existing) {
			existing.querySelector(".adhd-help-search")?.focus();
			return;
		}
		const $overlay = $(`
			<div class="adhd-help-modal-overlay">
				<div class="adhd-help-modal" role="dialog" aria-modal="true" aria-labelledby="adhd-help-title">
					<header><h2 id="adhd-help-title">${__("Keyboard Shortcuts")}</h2>
						<button type="button" class="adhd-help-close" aria-label="${__("Close")}">×</button>
					</header>
					${
						frappe.boot && frappe.boot.adhd_mode
							? ""
							: `<div class="adhd-help-mode-prompt">${__(
									"Turn on Focus Mode with the Focus button or Alt+A to unlock Focus Mode shortcuts."
							  )}</div>`
					}
					<input class="adhd-help-search" type="search" placeholder="${__("Search shortcuts…")}">
					<div class="adhd-help-list">${renderShortcuts(SHORTCUTS)}</div>
				</div>
			</div>
		`);
		$overlay.on("click", (event) => {
			if (event.target === $overlay[0]) closeHelpModal();
		});
		$overlay.on("keydown", (event) => {
			if (event.key === "Escape") closeHelpModal();
		});
		$overlay.find(".adhd-help-close").on("click", closeHelpModal);
		$overlay.find(".adhd-help-search").on("input", function () {
			const term = this.value.trim().toLowerCase();
			const filtered = SHORTCUTS.filter(
				(item) =>
					item.key.toLowerCase().includes(term) || item.description.toLowerCase().includes(term)
			);
			$overlay.find(".adhd-help-list").html(renderShortcuts(filtered, this.value.trim()));
		});
		$(document.body).append($overlay);
		$overlay.find(".adhd-help-search").trigger("focus");
	}

	// Alt+? is Alt+Shift+/. Match the physical key: on macOS, Option changes event.key ("¿" here), and
	// in a text field that character is what the person meant to type.
	function isHelpShortcut(event) {
		if (!event.altKey || event.ctrlKey || event.metaKey) return false;
		return (event.shiftKey && event.code === "Slash") || event.key === "?";
	}

	document.addEventListener("keydown", (event) => {
		if (!isHelpShortcut(event)) return;
		if (erpnext.adhd.isTypingTarget?.(event.target)) return;
		event.preventDefault();
		openHelpModal();
	});

	erpnext.adhd.SHORTCUTS = SHORTCUTS;
	erpnext.adhd.openHelpModal = openHelpModal;
	erpnext.adhd.isHelpShortcut = isHelpShortcut;
})();
