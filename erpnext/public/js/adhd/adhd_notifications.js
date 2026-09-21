// Copyright (c) 2024, ERPNext Contributors
// ADHD-Friendly Mode: Enhanced Notifications with Grouping and Snooze
// License: GNU General Public License v3. See license.txt

frappe.provide("erpnext.adhd");

const CLICK_EVENT = "click.adhd_notifications";

erpnext.adhd.Notifications = class ADHDNotifications {
	constructor() {
		this.snoozed = this._loadSnoozed();
		this._snoozeTimer = null;
		this.start();
	}

	// The mode can be switched off after this object exists, so what it runs is started and stopped with the mode.
	start() {
		this._patchNotificationBell();
		this._startSnoozeChecker();
	}

	stop() {
		$(document).off(CLICK_EVENT);
		clearInterval(this._snoozeTimer);
		this._snoozeTimer = null;
	}

	_loadSnoozed() {
		try {
			const data = localStorage.getItem("adhd_snoozed_notifs");
			return data ? JSON.parse(data) : {};
		} catch (e) {
			return {};
		}
	}

	_saveSnoozed() {
		localStorage.setItem("adhd_snoozed_notifs", JSON.stringify(this.snoozed));
	}

	_startSnoozeChecker() {
		clearInterval(this._snoozeTimer);
		// Check every minute if any snoozed notifications should reappear
		this._snoozeTimer = setInterval(() => {
			if (!frappe.boot.adhd_mode) {
				this.stop();
				return;
			}
			const now = Date.now();
			let changed = false;
			Object.keys(this.snoozed).forEach((key) => {
				if (this.snoozed[key] <= now) {
					delete this.snoozed[key];
					changed = true;
				}
			});
			if (changed) this._saveSnoozed();
		}, 60000);
	}

	snooze(notifId, durationMs) {
		this.snoozed[notifId] = Date.now() + durationMs;
		this._saveSnoozed();
		frappe.show_alert({ message: `💤 Snoozed for ${durationMs / 60000} minutes`, indicator: "gray" }, 2);
	}

	isSnoozed(notifId) {
		const until = this.snoozed[notifId];
		return until && until > Date.now();
	}

	_patchNotificationBell() {
		// Add ADHD grouping to the notification dropdown when it opens. Namespaced and re-bound, so starting twice
		// never doubles it and stop() takes off this handler only.
		$(document)
			.off(CLICK_EVENT)
			.on(CLICK_EVENT, ".notification-list, [data-toggle='notifications']", () => {
				if (!frappe.boot.adhd_mode) return;
				setTimeout(() => this._enhanceNotificationPanel(), 200);
			});
	}

	_enhanceNotificationPanel() {
		const panel = document.querySelector(".notifications-list, .notification-list");
		if (!panel || panel.classList.contains("adhd-enhanced")) return;
		panel.classList.add("adhd-enhanced");

		// Add a header label
		const header = document.createElement("div");
		header.className = "adhd-notif-header";
		header.innerHTML = `
			<span class="adhd-notif-header-title">🔔 Notifications</span>
			<button class="adhd-notif-clear-all" onclick="frappe.call('frappe.desk.notifications.mark_all_as_read')">
				Mark all read
			</button>
		`;
		panel.insertBefore(header, panel.firstChild);

		// Add snooze buttons to each notification
		panel.querySelectorAll(".notification-item, .dropdown-item").forEach((item) => {
			if (item.querySelector(".adhd-snooze-btn")) return;

			const snoozeGroup = document.createElement("div");
			snoozeGroup.className = "adhd-snooze-group";
			snoozeGroup.innerHTML = `
				<span class="adhd-snooze-label">Snooze:</span>
				<button class="adhd-snooze-btn" data-duration="900000">15m</button>
				<button class="adhd-snooze-btn" data-duration="3600000">1h</button>
				<button class="adhd-snooze-btn" data-duration="86400000">Tomorrow</button>
			`;

			const notifId = item.dataset.name || item.dataset.notifId || Math.random().toString(36);
			snoozeGroup.querySelectorAll(".adhd-snooze-btn").forEach((btn) => {
				btn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.snooze(notifId, parseInt(btn.dataset.duration));
					item.style.opacity = "0.4";
				});
			});

			item.appendChild(snoozeGroup);
		});
	}
};

let notifInstance = null;

erpnext.adhd.onStateChange &&
	erpnext.adhd.onStateChange((active) => {
		if (active) {
			if (!notifInstance) notifInstance = new erpnext.adhd.Notifications();
			else notifInstance.start();
		} else if (notifInstance) {
			notifInstance.stop();
		}
	});
