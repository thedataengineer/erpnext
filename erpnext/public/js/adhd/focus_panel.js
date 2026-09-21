// Copyright (c) 2024, ERPNext Contributors
// ADHD-Friendly Mode: Focus Panel (Priority Tasks + Pomodoro Timer)
// License: GNU General Public License v3. See license.txt

frappe.provide("erpnext.adhd");

erpnext.adhd.FocusPanel = class FocusPanel {
	constructor() {
		this.panel = null;
		this.timerInterval = null;
		this.timerSeconds = 25 * 60;
		this.timerRunning = false;
		this.timerMode = "work"; // "work" | "break"
		this._render();
		this._bindEvents();
		this._loadTasks();
	}

	_render() {
		if (document.getElementById("adhd-focus-panel")) return;

		const panel = document.createElement("div");
		panel.id = "adhd-focus-panel";
		panel.className = "adhd-focus-panel";
		panel.innerHTML = `
			<div class="afp-header">
				<span class="afp-title">🎯 Focus Panel</span>
				<div class="afp-header-actions">
					<button class="afp-btn-icon" id="afp-refresh" title="${__("Refresh tasks")}">↺</button>
					<button class="afp-btn-icon" id="afp-close" title="${__("Hide panel")}">✕</button>
				</div>
			</div>

			<div class="afp-body">
				<!-- ADHD Mode Switch -->
				<div class="afp-section afp-mode-section">
					<div class="afp-mode-copy">
						<div class="afp-section-title">🧠 ADHD Mode</div>
						<div class="afp-mode-description">Show focus-friendly tools and workflow guidance.</div>
					</div>
					<label class="afp-switch" for="afp-adhd-mode-switch">
						<input type="checkbox" id="afp-adhd-mode-switch" />
						<span class="afp-switch-slider"></span>
						<span class="sr-only">${__("Toggle ADHD Mode")}</span>
					</label>
				</div>

				<!-- Pomodoro Timer -->
				<div class="afp-section afp-timer-section">
					<div class="afp-section-title">⏱ Focus Timer</div>
					<div class="afp-timer-display">
						<svg class="afp-timer-ring" viewBox="0 0 100 100">
							<circle class="afp-ring-bg" cx="50" cy="50" r="44"/>
							<circle class="afp-ring-progress" id="afp-ring-circle" cx="50" cy="50" r="44"/>
						</svg>
						<div class="afp-timer-time" id="afp-timer-time">25:00</div>
					</div>
					<div class="afp-timer-label" id="afp-timer-label">Work Session</div>
					<div class="afp-timer-controls">
						<button class="afp-btn afp-btn-primary" id="afp-timer-start">▶ Start</button>
						<button class="afp-btn afp-btn-ghost" id="afp-timer-reset">Reset</button>
					</div>
					<div class="afp-timer-presets">
						<button class="afp-preset" data-mins="25">25m</button>
						<button class="afp-preset" data-mins="50">50m</button>
						<button class="afp-preset" data-mins="5">5m break</button>
					</div>
				</div>

				<!-- Today's Tasks -->
				<div class="afp-section">
					<div class="afp-section-title">📋 Your Tasks</div>
					<div id="afp-task-list" class="afp-task-list">
						<div class="afp-loading">Loading tasks…</div>
					</div>
				</div>

				<div class="afp-section">
					<button type="button" class="btn btn-default btn-sm afp-month-end-toggle">
						${__("📅 Month-End")}
					</button>
					<div class="afp-month-end" hidden></div>
				</div>

				<!-- Quick Note -->
				<div class="afp-section">
					<div class="afp-section-title">📝 Quick Note</div>
					<textarea id="afp-quick-note" class="afp-quick-note"
						placeholder="Brain dump here — what are you thinking about right now?"></textarea>
				</div>
			</div>

			<!-- Toggle tab on the left edge -->
			<button class="afp-toggle-tab" id="afp-toggle-tab" title="${__("Toggle Focus Panel")}">
				🎯
			</button>
		`;

		document.body.appendChild(panel);
		this.panel = panel;

		// Restore quick note
		const saved = localStorage.getItem("adhd_quick_note") || "";
		document.getElementById("afp-quick-note").value = saved;
		this._syncModeSwitch();
	}

	_bindEvents() {
		document.getElementById("afp-close")?.addEventListener("click", () => this.hide());
		document.getElementById("afp-refresh")?.addEventListener("click", () => this._loadTasks());
		document.getElementById("afp-toggle-tab")?.addEventListener("click", () => this.toggle());
		document.getElementById("afp-adhd-mode-switch")?.addEventListener("change", (e) => {
			if (e.target.checked) {
				erpnext.adhd.enable();
			} else {
				erpnext.adhd.disable();
			}
			this._syncModeSwitch();
		});

		document.getElementById("afp-timer-start")?.addEventListener("click", () => this._timerToggle());
		document.getElementById("afp-timer-reset")?.addEventListener("click", () => this._timerReset());
		document.querySelector(".afp-month-end-toggle")?.addEventListener("click", () => {
			const container = document.querySelector(".afp-month-end");
			if (!container) return;
			container.hidden = !container.hidden;
			this._activeTab = container.hidden ? "tasks" : "month_end";
			if (!container.hidden) erpnext.adhd.initMonthEndChecklist?.(container);
		});

		document.querySelectorAll(".afp-preset").forEach((btn) => {
			btn.addEventListener("click", () => {
				const mins = parseInt(btn.dataset.mins);
				this._timerReset(mins * 60);
				const label = document.getElementById("afp-timer-label");
				if (label) label.textContent = mins === 5 ? "Break Time 🌱" : `Work Session (${mins}m)`;
			});
		});

		// Save quick note on input
		document.getElementById("afp-quick-note")?.addEventListener("input", (e) => {
			localStorage.setItem("adhd_quick_note", e.target.value);
		});

		erpnext.adhd.onStateChange && erpnext.adhd.onStateChange(() => this._syncModeSwitch());
	}

	_syncModeSwitch() {
		const switchEl = document.getElementById("afp-adhd-mode-switch");
		if (!switchEl || !erpnext.adhd || !erpnext.adhd.isActive) return;
		switchEl.checked = erpnext.adhd.isActive();
	}

	async _loadTasks() {
		const listEl = document.getElementById("afp-task-list");
		if (!listEl) return;
		listEl.innerHTML = `<div class="afp-loading">Loading…</div>`;

		try {
			const user = frappe.session.user;
			const result = await frappe.call({
				method: "frappe.client.get_list",
				args: {
					doctype: "Task",
					filters: [
						["status", "in", ["Open", "Working", "Overdue"]],
					],
					fields: ["name", "subject", "status", "priority", "exp_end_date", "project", "progress"],
					order_by: "modified desc",
					limit: 20,
				},
			});

			const tasks = (result && result.message) || [];
			this._renderTasks(tasks);
		} catch (e) {
			listEl.innerHTML = `<div class="afp-empty">Could not load tasks. <a href="/app/task">View all tasks</a></div>`;
		}
	}

	_renderTasks(tasks) {
		const listEl = document.getElementById("afp-task-list");
		if (!listEl) return;

		if (!tasks.length) {
			listEl.innerHTML = `<div class="afp-empty">🎉 No open tasks! Time to plan your next steps.</div>`;
			return;
		}

		// Sort: Overdue first, then by priority, then by due date
		const priorityOrder = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
		tasks.sort((a, b) => {
			if (a.status === "Overdue" && b.status !== "Overdue") return -1;
			if (b.status === "Overdue" && a.status !== "Overdue") return 1;
			const pa = priorityOrder[a.priority] ?? 99;
			const pb = priorityOrder[b.priority] ?? 99;
			return pa - pb;
		});

		const now = new Date();
		listEl.innerHTML = tasks
			.map((t) => {
				const isOverdue = t.status === "Overdue";
				const isUrgent = t.priority === "Urgent";
				const dueDate = t.exp_end_date ? new Date(t.exp_end_date) : null;
				const dueSoon = dueDate && (dueDate - now) < 2 * 24 * 60 * 60 * 1000 && dueDate > now;

				const priorityEmoji =
					t.priority === "Urgent" ? "🔴"
					: t.priority === "High" ? "🟠"
					: t.priority === "Medium" ? "🟡"
					: "🟢";

				const dueLabel = isOverdue
					? `<span class="afp-due overdue">⚠ OVERDUE</span>`
					: dueDate
					? `<span class="afp-due ${dueSoon ? "due-soon" : ""}">Due ${frappe.datetime.prettyDate(t.exp_end_date)}</span>`
					: "";

				const progress = t.progress || 0;

				return `
				<div class="afp-task-card ${isOverdue ? "afp-task-overdue" : ""} ${isUrgent ? "afp-task-urgent" : ""}"
				     data-task="${t.name}">
					<div class="afp-task-header">
						<span class="afp-priority-dot">${priorityEmoji}</span>
						<a class="afp-task-subject" href="/app/task/${t.name}">${t.subject}</a>
					</div>
					${t.project ? `<div class="afp-task-project">📁 ${t.project}</div>` : ""}
					${dueLabel}
					${progress > 0 ? `
					<div class="afp-progress-bar">
						<div class="afp-progress-fill" style="width:${progress}%"></div>
					</div>` : ""}
					<div class="afp-task-actions">
						<button class="afp-btn-done afp-btn-sm" data-task="${t.name}" title="${__("Mark as Done")}">
							✓ Done
						</button>
						<button class="afp-btn-working afp-btn-sm" data-task="${t.name}" title="${__("Set to Working")}">
							▶ Working
						</button>
					</div>
				</div>`;
			})
			.join("");

		// Bind action buttons
		listEl.querySelectorAll(".afp-btn-done").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				this._updateTaskStatus(btn.dataset.task, "Completed");
			});
		});

		listEl.querySelectorAll(".afp-btn-working").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				this._updateTaskStatus(btn.dataset.task, "Working");
			});
		});
	}

	async _updateTaskStatus(taskName, status) {
		try {
			await frappe.call({
				method: "frappe.client.set_value",
				args: { doctype: "Task", name: taskName, fieldname: "status", value: status },
			});

			const card = document.querySelector(`.afp-task-card[data-task="${taskName}"]`);
			if (card) {
				if (status === "Completed") {
					card.classList.add("afp-task-done-anim");
					setTimeout(() => card.remove(), 600);
					frappe.show_alert({ message: "✅ Task marked as Done! Great work!", indicator: "green" }, 3);
				} else {
					card.classList.add("afp-task-working-anim");
					setTimeout(() => this._loadTasks(), 600);
					frappe.show_alert({ message: "▶ Task set to Working!", indicator: "blue" }, 2);
				}
			}
		} catch (e) {
			frappe.msgprint(__("Could not update task. Please try again."));
		}
	}

	// --- Pomodoro Timer ---
	_timerToggle() {
		if (this.timerRunning) {
			this._timerPause();
		} else {
			this._timerStart();
		}
	}

	_timerStart() {
		this.timerRunning = true;
		const startBtn = document.getElementById("afp-timer-start");
		if (startBtn) startBtn.textContent = "⏸ Pause";

		this.timerInterval = setInterval(() => {
			this.timerSeconds--;
			this._updateTimerDisplay();

			if (this.timerSeconds <= 0) {
				this._timerComplete();
			}
		}, 1000);
	}

	_timerPause() {
		clearInterval(this.timerInterval);
		this.timerRunning = false;
		const startBtn = document.getElementById("afp-timer-start");
		if (startBtn) startBtn.textContent = "▶ Resume";
	}

	_timerReset(seconds) {
		clearInterval(this.timerInterval);
		this.timerRunning = false;
		this.timerSeconds = seconds !== undefined ? seconds : 25 * 60;
		const startBtn = document.getElementById("afp-timer-start");
		if (startBtn) startBtn.textContent = "▶ Start";
		this._updateTimerDisplay();
	}

	_timerComplete() {
		clearInterval(this.timerInterval);
		this.timerRunning = false;

		const startBtn = document.getElementById("afp-timer-start");
		if (startBtn) startBtn.textContent = "▶ Start";

		const label = document.getElementById("afp-timer-label");

		if (this.timerMode === "work") {
			this.timerMode = "break";
			this.timerSeconds = 5 * 60;
			if (label) label.textContent = "Break Time! 🌱";
			frappe.show_alert({ message: "🎉 Pomodoro complete! Take a 5-minute break.", indicator: "green" }, 8);
		} else {
			this.timerMode = "work";
			this.timerSeconds = 25 * 60;
			if (label) label.textContent = "Work Session";
			frappe.show_alert({ message: "🧠 Break over! Back to focus.", indicator: "blue" }, 5);
		}

		this._updateTimerDisplay();

		// Browser notification
		if (Notification && Notification.permission === "granted") {
			new Notification("⏰ ERPNext Focus Timer", {
				body: this.timerMode === "break" ? "Work session done! Take a break." : "Break over! Time to focus.",
				icon: "/assets/erpnext/images/erpnext-logo.svg",
			});
		}
	}

	_updateTimerDisplay() {
		const timeEl = document.getElementById("afp-timer-time");
		const circleEl = document.getElementById("afp-ring-circle");

		const total = this.timerMode === "work" ? 25 * 60 : 5 * 60;
		const mins = Math.floor(this.timerSeconds / 60);
		const secs = this.timerSeconds % 60;

		if (timeEl) {
			timeEl.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
		}

		if (circleEl) {
			const circumference = 2 * Math.PI * 44; // r=44
			const progress = this.timerSeconds / total;
			const offset = circumference * (1 - progress);
			circleEl.style.strokeDasharray = circumference;
			circleEl.style.strokeDashoffset = offset;
		}
	}

	show() {
		if (this.panel) {
			this.panel.classList.add("visible");
			this._loadTasks();
			localStorage.setItem("adhd_focus_panel_visible", "1");
		}
	}

	hide() {
		if (this.panel) {
			this.panel.classList.remove("visible");
			localStorage.setItem("adhd_focus_panel_visible", "0");
		}
	}

	toggle() {
		if (this.panel) {
			if (this.panel.classList.contains("visible")) {
				this.hide();
			} else {
				this.show();
			}
		}
	}

	destroy() {
		if (this.panel) {
			this.panel.remove();
			this.panel = null;
		}
		clearInterval(this.timerInterval);
	}
};

// Initialize when ADHD mode state changes
erpnext.adhd.onStateChange && erpnext.adhd.onStateChange((active) => {
	if (active) {
		if (!erpnext.adhd.focusPanel) {
			erpnext.adhd.focusPanel = new erpnext.adhd.FocusPanel();
		}

		// Request notification permission
		if (Notification && Notification.permission === "default") {
			Notification.requestPermission();
		}

		// Restore visibility
		const wasVisible = localStorage.getItem("adhd_focus_panel_visible");
		if (wasVisible !== "0") {
			erpnext.adhd.focusPanel.show();
		}
	} else {
		if (erpnext.adhd.focusPanel) {
			erpnext.adhd.focusPanel.hide();
		}
	}
});
