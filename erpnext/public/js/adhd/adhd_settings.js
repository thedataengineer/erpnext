// Copyright (c) 2026, ERPNext Contributors
// ADHD mode per-feature settings.

frappe.provide("erpnext.adhd");

erpnext.adhd.ADHD_FEATURES = [
	{ key: "pomodoro", label: __("Pomodoro Timer"), defaultOn: true },
	{ key: "task_kanban", label: __("Task Kanban View"), defaultOn: true },
	{ key: "due_date_heatmap", label: __("Due-Date Heat Maps"), defaultOn: true },
	{ key: "timebox_warnings", label: __("Time-Boxing Warnings"), defaultOn: true },
	{ key: "form_banners", label: __("Contextual Form Banners"), defaultOn: true },
	{ key: "mandatory_wizard", label: __("Mandatory Field Wizard"), defaultOn: true },
	{ key: "auto_timelog", label: __("Auto Time-Log Prompt"), defaultOn: false },
	{ key: "payment_digest", label: __("Daily Payment Digest"), defaultOn: false },
	{ key: "balance_meter", label: __("Journal Entry Balance Meter"), defaultOn: true },
	{ key: "friction_logger", label: __("Friction Logger"), defaultOn: false },
	{ key: "done_well", label: __('"Done Well" Confirmations'), defaultOn: true },
];

const STORAGE_PREFIX = "adhd_setting_";

function getFeature(key) {
	return erpnext.adhd.ADHD_FEATURES.find((feature) => feature.key === key);
}

erpnext.adhd.ADHDSettings = {
	_dialog: null,

	get(key) {
		const feature = getFeature(key);
		if (!feature) return false;
		const stored = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
		return stored === null ? feature.defaultOn : stored === "true";
	},

	set(key, value) {
		if (!getFeature(key)) return;
		const enabled = Boolean(value);
		localStorage.setItem(`${STORAGE_PREFIX}${key}`, String(enabled));
		$(document).trigger("adhd_setting_changed", [{ key, value: enabled }]);
	},

	reset() {
		erpnext.adhd.ADHD_FEATURES.forEach((feature) => {
			localStorage.setItem(`${STORAGE_PREFIX}${feature.key}`, String(feature.defaultOn));
		});
		$(document).trigger("adhd_settings_reset");
	},

	clearUsageHistory() {
		Object.keys(localStorage)
			.filter(
				(key) =>
					key.startsWith("adhd_module_freq_") ||
					key === "adhd_session_dates" ||
					key.startsWith("adhd_suggestion_dismissed_"),
			)
			.forEach((key) => localStorage.removeItem(key));
		$(document).trigger("adhd_usage_history_cleared");
	},

	openPanel() {
		if (this._dialog && this._dialog.$wrapper?.is(":visible")) {
			this._dialog.$wrapper.focus();
			return;
		}

		const rows = erpnext.adhd.ADHD_FEATURES.map(
			(feature) => `
				<label class="adhd-setting-row">
					<span>${frappe.utils.escape_html(feature.label)}</span>
					<input class="adhd-toggle-switch" type="checkbox"
						data-feature="${feature.key}" ${this.get(feature.key) ? "checked" : ""}>
				</label>`,
		).join("");

		const dialog = new frappe.ui.Dialog({
			title: __("🧠 ADHD Mode Settings"),
			fields: [{ fieldtype: "HTML", fieldname: "settings" }],
			primary_action_label: __("Done"),
			primary_action: () => dialog.hide(),
		});
		this._dialog = dialog;
		dialog.fields_dict.settings.$wrapper.html(`
			<div class="adhd-settings-list">${rows}</div>
			<div class="adhd-settings-actions">
				<button type="button" class="btn btn-default btn-sm adhd-settings-reset">${__("Reset to Defaults")}</button>
				<button type="button" class="btn btn-default btn-sm adhd-clear-accounting-defaults">${__(
					"Clear accounting defaults",
				)}</button>
				<button type="button" class="btn btn-default btn-sm adhd-clear-usage">${__("Clear usage history")}</button>
			</div>
		`);
		dialog.fields_dict.settings.$wrapper.on("change", ".adhd-toggle-switch", (event) => {
			this.set(event.currentTarget.dataset.feature, event.currentTarget.checked);
		});
		dialog.fields_dict.settings.$wrapper.on("click", ".adhd-settings-reset", () => {
			this.reset();
			dialog.fields_dict.settings.$wrapper.find(".adhd-toggle-switch").each((_, input) => {
				input.checked = this.get(input.dataset.feature);
			});
		});
		dialog.fields_dict.settings.$wrapper.on("click", ".adhd-clear-usage", () => {
			this.clearUsageHistory();
			frappe.show_alert({ message: __("Usage history cleared."), indicator: "green" }, 2);
		});
		dialog.fields_dict.settings.$wrapper.on("click", ".adhd-clear-accounting-defaults", () => {
			window.adhdClearLastUsedDefaults?.();
		});
		dialog.show();
	},
};

window.ADHDSettings = erpnext.adhd.ADHDSettings;
