// Opt-in anonymous interaction signal queue.

frappe.provide("erpnext.adhd");

const TELEMETRY_METHOD = "erpnext.adhd_usage_log.doctype.adhd_usage_log.adhd_usage_log.log_adhd_event";

erpnext.adhd.ADHDTelemetry = {
	_queue: [],

	isEnabled() {
		return Boolean(window.ADHDSettings?.get("friction_logger"));
	},

	emit(event) {
		if (!this.isEnabled() || !event?.event_type) return;
		this._queue.push({ ...event });
	},

	flushQueue() {
		if (!this.isEnabled() || !this._queue.length) return Promise.resolve([]);
		const events = this._queue.splice(0);
		return Promise.allSettled(
			events.map((event) =>
				frappe.call({
					method: TELEMETRY_METHOD,
					args: event,
				}),
			),
		);
	},
};

window.ADHDTelemetry = erpnext.adhd.ADHDTelemetry;
setInterval(() => erpnext.adhd.ADHDTelemetry.flushQueue(), 30000);
window.addEventListener("beforeunload", () => {
	// Frappe's RPC endpoint requires form-encoded arguments and CSRF context.
	// keepalive preserves that contract while allowing navigation to continue.
	if (!erpnext.adhd.ADHDTelemetry.isEnabled()) return;
	const events = erpnext.adhd.ADHDTelemetry._queue.splice(0);
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
