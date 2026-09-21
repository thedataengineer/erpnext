// Copyright (c) 2024, ERPNext Contributors
// ADHD-Friendly Mode: Core Toggle & State Management
// License: GNU General Public License v3. See license.txt

frappe.provide("erpnext.adhd");

erpnext.adhd.STORAGE_KEY = "erpnext_adhd_mode";
erpnext.adhd.CLASS = "adhd-mode";

erpnext.adhd.ADHDMode = class ADHDMode {
	constructor() {
		this.active = false;
		this.observers = [];
		this._init();
	}

	_init() {
		const stored = localStorage.getItem(erpnext.adhd.STORAGE_KEY);
		if (stored === "on") {
			this._apply(true, false);
		}

			document.addEventListener("keydown", (e) => {
				const isADHDShortcut = e.altKey && (e.key === "a" || e.key === "A" || e.code === "KeyA");
				if (isADHDShortcut && !e.ctrlKey && !e.metaKey) {
				const tag = document.activeElement && document.activeElement.tagName;
				if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
				e.preventDefault();
				this.toggle();
			}
		});
	}

	toggle() {
		this._apply(!this.active, true);
	}

	enable() {
		this._apply(true, true);
	}

	disable() {
		this._apply(false, true);
	}

	_apply(state, notify = true) {
		this.active = state;
		frappe.boot.adhd_mode = state;
		localStorage.setItem(erpnext.adhd.STORAGE_KEY, state ? "on" : "off");

		if (state) {
			document.body.classList.add(erpnext.adhd.CLASS);
			document.body.setAttribute("data-adhd-mode", "on");
		} else {
			document.body.classList.remove(erpnext.adhd.CLASS);
			document.body.setAttribute("data-adhd-mode", "off");
		}

		this._updateToggleButton();

		this.observers.forEach((fn) => {
			try { fn(state); } catch (e) { console.error("[ADHD Mode] Observer error:", e); }
		});

		if (notify) {
			this._showToast(state);
		}
	}

	_showToast(state) {
		const msg = state
			? "🧠 Focus Mode ON — Distractions minimized."
			: "Focus Mode OFF — Standard view restored.";

		frappe.show_alert({ message: __(msg), indicator: state ? "blue" : "gray" }, 4);
	}

	_updateToggleButton() {
		const btn = document.getElementById("adhd-mode-toggle");
		if (!btn) return;

		if (this.active) {
			btn.classList.add("active");
			btn.setAttribute("title", __("Focus Mode: ON (Alt+A to toggle)"));
		} else {
			btn.classList.remove("active");
			btn.setAttribute("title", __("Focus Mode: OFF (Alt+A to toggle)"));
		}
	}

	onStateChange(fn) {
		this.observers.push(fn);
		fn(this.active);
	}

	isActive() {
		return this.active;
	}
};

erpnext.adhd.mode = new erpnext.adhd.ADHDMode();

frappe.after_ajax(() => {
	_addNavbarToggle();
});

function _addNavbarToggle() {
	const interval = setInterval(() => {
		const navbarRight = document.querySelector(".navbar-right, .nav.navbar-nav:last-child, .navbar .dropdown-list");
		if (!navbarRight) return;

		clearInterval(interval);

		if (document.getElementById("adhd-mode-toggle")) return;

		const li = document.createElement("li");
		li.className = "nav-item adhd-nav-item";
		li.innerHTML = `
			<a id="adhd-mode-toggle"
			   class="adhd-mode-toggle-btn nav-link"
			   title="${__("Focus Mode (Alt+A)")}"
			   href="#">
				<span class="adhd-toggle-icon">🧠</span>
				<span class="adhd-toggle-label">${__("Focus")}</span>
			</a>
		`;

		navbarRight.parentNode && navbarRight.parentNode.insertBefore(li, navbarRight);

		const toggle = document.getElementById("adhd-mode-toggle");
		let longPressTimer = null;
		let settingsOpened = false;
		const cancelLongPress = () => {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		};
		toggle.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			window.ADHDSettings?.openPanel();
		});
		toggle.addEventListener("mousedown", () => {
			settingsOpened = false;
			longPressTimer = setTimeout(() => {
				settingsOpened = true;
				window.ADHDSettings?.openPanel();
			}, 600);
		});
		["mouseup", "mouseleave"].forEach((eventName) =>
			toggle.addEventListener(eventName, cancelLongPress)
		);
		toggle.addEventListener("click", (e) => {
			e.preventDefault();
			cancelLongPress();
			if (settingsOpened) {
				settingsOpened = false;
				return;
			}
			erpnext.adhd.mode.toggle();
		});

		erpnext.adhd.mode._updateToggleButton();
	}, 300);
}

erpnext.adhd.isActive = () => erpnext.adhd.mode.isActive();
erpnext.adhd.onStateChange = (fn) => erpnext.adhd.mode.onStateChange(fn);
erpnext.adhd.enable = () => erpnext.adhd.mode.enable();
erpnext.adhd.disable = () => erpnext.adhd.mode.disable();
erpnext.adhd.toggle = () => erpnext.adhd.mode.toggle();

frappe.ui.form.on("*", {
	before_save(frm) {
		frm._adhdSaveStart = Date.now();
	},
	after_save(frm) {
		if (!frm._adhdSaveStart) return;
		window.ADHDTelemetry?.emit({
			event_type: "form_save",
			doctype_name: frm.doctype,
			duration_ms: Date.now() - frm._adhdSaveStart,
		});
		delete frm._adhdSaveStart;
	},
});
