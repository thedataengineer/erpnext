// Opt-in anonymous interaction signal queue.

frappe.provide("erpnext.adhd");

const TELEMETRY_METHOD = "erpnext.focus_usage_log.doctype.focus_usage_log.focus_usage_log.log_focus_event";
// The arguments log_focus_event takes. An event carries these and nothing else.
const TELEMETRY_FIELDS = ["event_type", "doctype_name", "field_name", "duration_ms", "step_index", "intent"];

erpnext.adhd.ADHDTelemetry = {
	_queue: [],

	// Signals are gathered only while ADHD mode is on and the person switched the friction logger on. Whether
	// the site stores them is a separate opt-in that the server checks (System Settings > adhd_telemetry_enabled).
	isEnabled() {
		const modeOn = Boolean(erpnext.adhd.isActive && erpnext.adhd.isActive());
		return modeOn && Boolean(window.ADHDSettings?.get("friction_logger"));
	},

	emit(event) {
		if (!this.isEnabled() || !event?.event_type) return;
		this._queue.push(this._pick(event));
	},

	_pick(event) {
		return Object.fromEntries(
			TELEMETRY_FIELDS.filter((field) => event[field] != null).map((field) => [field, event[field]])
		);
	},

	// Whatever is still queued when the switch goes off was gathered under the old choice: drop it, do not send it.
	_take() {
		const events = this._queue.splice(0);
		return this.isEnabled() ? events : [];
	},

	flushQueue() {
		const events = this._take();
		if (!events.length) return Promise.resolve([]);
		return Promise.allSettled(
			events.map((event) =>
				frappe.call({
					method: TELEMETRY_METHOD,
					args: event,
				})
			)
		);
	},
};

window.ADHDTelemetry = erpnext.adhd.ADHDTelemetry;
setInterval(() => erpnext.adhd.ADHDTelemetry.flushQueue(), 30000);
window.addEventListener("beforeunload", () => {
	// Frappe's RPC endpoint requires form-encoded arguments and CSRF context.
	// keepalive preserves that contract while allowing navigation to continue.
	const events = erpnext.adhd.ADHDTelemetry._take();
	events.forEach((event) => {
		const body = new URLSearchParams();
		Object.entries(event).forEach(([key, value]) => body.set(key, value ?? ""));
		fetch(`/api/method/${TELEMETRY_METHOD}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
				"X-Frappe-CSRF-Token": frappe.csrf_token,
			},
			body,
			keepalive: true,
		}).catch(() => {});
	});
});
