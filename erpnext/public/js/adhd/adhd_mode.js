// Copyright (c) 2024, ERPNext Contributors
// ADHD-Friendly Mode: Core Toggle & State Management
// License: GNU General Public License v3. See license.txt

frappe.provide("erpnext.adhd");

erpnext.adhd.STORAGE_KEY = "erpnext_adhd_mode";
erpnext.adhd.CLASS = "adhd-mode";

// The mode is remembered per user, so a second person on the same browser
// does not inherit it. STORAGE_KEY stays the legacy (global) key name.
erpnext.adhd.currentUser = () =>
	(frappe.session && frappe.session.user) ||
	(typeof frappe.get_cookie === "function" && frappe.get_cookie("user_id")) ||
	"Guest";
erpnext.adhd.storageKey = () => `${erpnext.adhd.STORAGE_KEY}:${erpnext.adhd.currentUser()}`;

// True when a keystroke is going into something the person is typing in. Alt+<letter> there is a
// character (Option+A is "å" on macOS) or a rich-text command, so the shortcuts leave it alone. The editors
// are listed too: Frappe's text editor is a contenteditable .ql-editor, Ace keeps a hidden textarea.
erpnext.adhd.TYPING_TARGETS =
	'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .ql-editor, .ace_editor, .CodeMirror, .note-editable';
erpnext.adhd.isTypingTarget = (target) => {
	if (!target || !target.tagName) return false;
	return Boolean(target.isContentEditable || target.closest?.(erpnext.adhd.TYPING_TARGETS));
};

erpnext.adhd.readStoredMode = () => {
	const key = erpnext.adhd.storageKey();
	const stored = localStorage.getItem(key);
	if (stored !== null) return stored;

	// One-time migration: the first user to load after this change keeps the
	// setting that used to be shared, then the shared key is dropped.
	const legacy = localStorage.getItem(erpnext.adhd.STORAGE_KEY);
	if (legacy === null || erpnext.adhd.currentUser() === "Guest") return legacy;
	localStorage.setItem(key, legacy);
	localStorage.removeItem(erpnext.adhd.STORAGE_KEY);
	return legacy;
};

erpnext.adhd.ADHDMode = class ADHDMode {
	constructor() {
		this.active = false;
		this.observers = [];
		this._init();
	}

	_init() {
		const stored = erpnext.adhd.readStoredMode();
		if (stored === "on") {
			this._apply(true, false);
		}

		document.addEventListener("keydown", (e) => {
			// Match the physical key: on macOS, Option changes e.key ("å" for Option+A).
			if (e.altKey && e.code === "KeyA" && !e.ctrlKey && !e.metaKey) {
				if (
					erpnext.adhd.isTypingTarget(e.target) ||
					erpnext.adhd.isTypingTarget(document.activeElement)
				) {
					return;
				}
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

	activate() {
		this.enable();
	}

	disable() {
		this._apply(false, true);
	}

	deactivate() {
		this.disable();
	}

	_apply(state, notify = true) {
		this.active = state;
		frappe.boot.adhd_mode = state;
		localStorage.setItem(erpnext.adhd.storageKey(), state ? "on" : "off");

		if (state) {
			document.body.classList.add(erpnext.adhd.CLASS);
			document.body.setAttribute("data-adhd-mode", "on");
		} else {
			document.body.classList.remove(erpnext.adhd.CLASS);
			document.body.setAttribute("data-adhd-mode", "off");
		}

		this._updateToggleButton();

		this.observers.forEach((fn) => {
			try {
				fn(state);
			} catch (e) {
				console.error("[ADHD Mode] Observer error:", e);
			}
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

	getState() {
		const settings =
			window.ADHDSettings && erpnext.adhd.ADHD_FEATURES
				? Object.fromEntries(
						erpnext.adhd.ADHD_FEATURES.map((feature) => [
							feature.key,
							window.ADHDSettings.get(feature.key),
						])
				  )
				: {};
		return {
			isActive: this.active,
			enabledSettings: settings,
			pomodoroRunning: Boolean(erpnext.adhd.focusPanel?.timerRunning),
			currentForm: window.cur_frm?.doctype || null,
		};
	}
};

erpnext.adhd.mode = new erpnext.adhd.ADHDMode();
window.ADHDMode = erpnext.adhd.mode;

// This Frappe's desk has no navbar: the icon buttons live in the dock rail and, for an app without a rail,
// in the sidebar's standard-items band (frappe/ui/sidebar/dock.js, sidebar.js). `.navbar-right` is the
// older navbar. The toggle goes in the first of these that is on screen.
const NAVBAR_TARGETS = [".dock-shortcuts", ".standard-items-band", ".navbar-right"];
const NAVBAR_MOUNT_TRIES = 40;
const NAVBAR_MOUNT_DELAY_MS = 300;

frappe.after_ajax(() => {
	_addNavbarToggle();
});

function _isShown(element) {
	return element.getClientRects().length > 0;
}

function _findNavbarTarget() {
	for (const selector of NAVBAR_TARGETS) {
		const element = document.querySelector(selector);
		if (element && _isShown(element)) return element;
	}
	return null;
}

// Returns true once the toggle is in the page.
function _mountNavbarToggle() {
	const target = _findNavbarTarget();
	const existing = document.getElementById("adhd-mode-toggle");
	if (existing) {
		// The rail and the band take turns between apps: follow whichever one is on screen.
		const item = existing.closest(".adhd-nav-item");
		if (target && item && !_isShown(item)) target.appendChild(item);
		return true;
	}
	if (!target) return false;

	const item = document.createElement(/^(UL|OL)$/.test(target.tagName) ? "li" : "div");
	item.className = "nav-item adhd-nav-item";
	item.innerHTML = `
		<a id="adhd-mode-toggle"
		   class="adhd-mode-toggle-btn nav-link"
		   title="${__("Focus Mode (Alt+A)")}"
		   href="#">
			<span class="adhd-toggle-icon">🧠</span>
			<span class="adhd-toggle-label">${__("Focus")}</span>
		</a>
	`;
	target.appendChild(item);

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
	["mouseup", "mouseleave"].forEach((eventName) => toggle.addEventListener(eventName, cancelLongPress));
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
	return true;
}

function _addNavbarToggle() {
	// The rail and the sidebar are built a little after the page loads: try for a few seconds, then stop.
	let tries = 0;
	const interval = setInterval(() => {
		tries += 1;
		if (_mountNavbarToggle() || tries >= NAVBAR_MOUNT_TRIES) clearInterval(interval);
	}, NAVBAR_MOUNT_DELAY_MS);

	// A page change can bring the rail or the band on screen later, or swap one for the other.
	$(document).on("page-change", _mountNavbarToggle);
}

erpnext.adhd.isActive = () => erpnext.adhd.mode.isActive();
erpnext.adhd.onStateChange = (fn) => erpnext.adhd.mode.onStateChange(fn);
erpnext.adhd.enable = () => erpnext.adhd.mode.enable();
erpnext.adhd.disable = () => erpnext.adhd.mode.disable();
erpnext.adhd.toggle = () => erpnext.adhd.mode.toggle();

let doneWellTimer = null;
erpnext.adhd.showDoneWell = (message, cardElement) => {
	if (!erpnext.adhd.mode.isActive() || (window.ADHDSettings && !window.ADHDSettings.get("done_well"))) {
		return;
	}
	clearTimeout(doneWellTimer);
	frappe.show_alert({ message, indicator: "green" }, 2);
	document.body.classList.remove("adhd-done-pulse");
	void document.body.offsetWidth;
	document.body.classList.add("adhd-done-pulse");
	doneWellTimer = setTimeout(() => document.body.classList.remove("adhd-done-pulse"), 600);
	if (cardElement) {
		cardElement.classList.add("adhd-card-done");
		cardElement.addEventListener("animationend", () => cardElement.classList.remove("adhd-card-done"), {
			once: true,
		});
	}
};

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
	after_submit(frm) {
		erpnext.adhd.showDoneWell(__("{0} {1} submitted.", [frm.doc.doctype, frm.doc.name]));
	},
});
