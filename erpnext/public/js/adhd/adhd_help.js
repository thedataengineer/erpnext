// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors

frappe.provide("erpnext.adhd");

(() => {
	const SHORTCUTS = [
		{ context: "ADHD Mode", key: "Alt+?", description: "Open this shortcut reference" },
		{ context: "ADHD Mode", key: "Alt+A", description: "Toggle ADHD mode" },
		{ context: "ADHD Mode", key: "Alt+F", description: "Open Focus Panel" },
		{ context: "ADHD Mode", key: "Alt+N", description: "Open command bar" },
		{ context: "ADHD Mode", key: "Alt+R", description: "Resume the last edited document" },
		{ context: "Global", key: "Ctrl+G", description: "Open Awesomebar" },
		{ context: "Global", key: "Ctrl+S", description: "Save current document" },
		{ context: "Global", key: "Ctrl+E", description: "Toggle edit mode" },
		{ context: "Global", key: "Ctrl+/", description: "Focus global search" },
		{ context: "List View", key: "Ctrl+N", description: "Create a document" },
		{ context: "List View", key: "Shift+↑/↓", description: "Select multiple rows" },
		{ context: "List View", key: "Ctrl+A", description: "Select all visible rows" },
		{ context: "List View", key: "Delete", description: "Delete selected rows" },
		{ context: "Form", key: "Ctrl+S", description: "Save" },
		{ context: "Form", key: "Ctrl+Z", description: "Discard unsaved changes" },
		{ context: "Form", key: "Alt+→", description: "Open next document" },
		{ context: "Form", key: "Alt+←", description: "Open previous document" },
		{ context: "Form", key: "F5", description: "Reload document" },
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
									`<tr><td class="adhd-help-key"><kbd>${escape(item.key)}</kbd></td><td>${escape(
										__(item.description),
									)}</td></tr>`,
							)
							.join("")}
					</tbody></table>
				</section>`,
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
					${frappe.boot && frappe.boot.adhd_mode ? "" : `<div class="adhd-help-mode-prompt">${__("Enable ADHD Mode in User Settings to unlock ADHD-specific shortcuts.")}</div>`}
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
					item.key.toLowerCase().includes(term) || item.description.toLowerCase().includes(term),
			);
			$overlay.find(".adhd-help-list").html(renderShortcuts(filtered, this.value.trim()));
		});
		$(document.body).append($overlay);
		$overlay.find(".adhd-help-search").trigger("focus");
	}

	document.addEventListener("keydown", (event) => {
		if (event.altKey && event.key === "?") {
			event.preventDefault();
			openHelpModal();
		}
	});

	erpnext.adhd.SHORTCUTS = SHORTCUTS;
	erpnext.adhd.openHelpModal = openHelpModal;
})();
