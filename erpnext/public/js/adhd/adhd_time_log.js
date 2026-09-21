// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors

(() => {
	const FocusPanel = erpnext.adhd.FocusPanel;
	const originalRenderTasks = FocusPanel.prototype._renderTasks;
	const originalTimerStart = FocusPanel.prototype._timerStart;
	const originalTimerReset = FocusPanel.prototype._timerReset;
	const originalTimerComplete = FocusPanel.prototype._timerComplete;
	const BREAK_SECONDS = 5 * 60;

	FocusPanel.prototype._renderTasks = function (tasks) {
		originalRenderTasks.call(this, tasks);
		const list = document.getElementById("afp-task-list");
		list?.querySelectorAll(".afp-task-card").forEach((card) => {
			card.addEventListener("click", (event) => {
				if (event.target.closest("a, button")) return;
				const task = tasks.find((item) => item.name === card.dataset.task);
				if (!task) return;
				this.activeTask = task;
				list.querySelectorAll(".afp-task-card").forEach((item) => item.classList.remove("selected"));
				card.classList.add("selected");
				frappe.show_alert({ message: __("Timer linked to {0}", [task.subject]), indicator: "blue" });
			});
		});
	};

	// frappe.datetime has no add_minutes, so go through moment with the system datetime format.
	function minutesBefore(datetime, minutes) {
		return moment(datetime, frappe.defaultDatetimeFormat)
			.subtract(minutes, "minutes")
			.format(frappe.defaultDatetimeFormat);
	}

	FocusPanel.prototype._timerStart = function () {
		// One session is one Start..complete span, however many pauses it has. Whether it is a break is
		// read from its length: timerMode cannot say, because the "5m break" preset leaves it on "work"
		// and a preset picked after a break leaves it on "break".
		if (this._sessionMinutes == null) {
			this._sessionMinutes = this.timerSeconds / 60;
			this._sessionIsBreak = this.timerSeconds === BREAK_SECONDS;
		}
		return originalTimerStart.call(this);
	};

	FocusPanel.prototype._timerReset = function (...args) {
		this._sessionMinutes = null;
		this._sessionIsBreak = false;
		return originalTimerReset.apply(this, args);
	};

	FocusPanel.prototype._timerComplete = function () {
		const sessionMinutes = this._sessionMinutes;
		let completedWork = sessionMinutes != null && !this._sessionIsBreak;
		const result = originalTimerComplete.call(this);
		// a focus panel that reports what ran out ({ mode, minutes }) knows better than the length guess
		if (result?.mode) completedWork = result.mode === "work";
		const minutes = sessionMinutes ?? result?.minutes;
		this._sessionMinutes = null;
		this._sessionIsBreak = false;
		if (completedWork && minutes && this.activeTask && frappe.boot.adhd_mode) {
			// Timesheet recomputes hours from from/to on save, so the two times must span exactly the
			// minutes counted here: a paused session's wall-clock span would save more than the banner says.
			const toTime = frappe.datetime.now_datetime();
			this._renderTimeLogBanner({
				fromTime: minutesBefore(toTime, minutes),
				toTime,
				hours: minutes / 60,
				task: this.activeTask,
				project: this.activeTask.project || null,
				activityType: frappe.boot.adhd_default_activity_type || "Execution",
			});
		}
		return result;
	};

	FocusPanel.prototype._renderTimeLogBanner = function (options) {
		const body = this.panel?.querySelector(".afp-body");
		if (!body) return;
		body.querySelector(".adhd-timelog-prompt")?.remove();
		const banner = document.createElement("div");
		banner.className = "adhd-timelog-prompt";
		banner.innerHTML = `
			<p class="adhd-timelog-summary">${__("Session complete — log")} <strong>${options.hours.toFixed(2)}h</strong>
				${__("on")} <strong>${frappe.utils.escape_html(options.task.subject || options.task.name)}</strong>?</p>
			<div class="adhd-timelog-detail">${frappe.utils.escape_html(options.fromTime)} → ${frappe.utils.escape_html(options.toTime)} · ${frappe.utils.escape_html(options.activityType)}</div>
			<div class="adhd-timelog-actions">
				<button type="button" class="btn btn-primary btn-sm adhd-timelog-log">${__("Log Time")}</button>
				<button type="button" class="btn btn-default btn-sm adhd-timelog-skip">${__("Skip")}</button>
			</div>`;
		body.appendChild(banner);
		banner.querySelector(".adhd-timelog-skip").addEventListener("click", () => banner.remove());
		banner.querySelector(".adhd-timelog-log").addEventListener("click", async (event) => {
			event.currentTarget.disabled = true;
			try {
				const saved = await this._saveTimeLog(options);
				if (saved) {
					frappe.show_alert({
						message: __("Time logged on {0}", [options.task.subject || options.task.name]),
						indicator: "green",
					});
				}
				// with no employee there is nothing to retry either, so the prompt goes in both cases
				banner.remove();
			} catch (error) {
				event.currentTarget.disabled = false;
				console.warn("[ADHD Focus Panel] Could not log time", error);
				frappe.show_alert({ message: __("Could not log time. Try again."), indicator: "red" });
			}
		});
		setTimeout(() => banner.remove(), 5 * 60 * 1000);
	};

	// The Employee of the signed-in user; boot has no employee, so ask for the one linked by user_id.
	FocusPanel.prototype._getEmployee = async function () {
		if (!this._employee) {
			const response = await frappe.db.get_value(
				"Employee",
				{ user_id: frappe.session.user, status: "Active" },
				"name",
			);
			this._employee = response?.message?.name || null;
		}
		return this._employee;
	};

	FocusPanel.prototype._saveTimeLog = async function (options) {
		// Without an employee the Timesheet overlap check is skipped and the "today's draft" lookup below
		// would match any employee-less draft, so do not log at all.
		const employee = await this._getEmployee();
		if (!employee) {
			frappe.show_alert({
				message: __("No active Employee is linked to your user, so this time was not logged."),
				indicator: "orange",
			});
			return null;
		}
		const response = await frappe.call({
			method: "frappe.client.get_list",
			args: {
				doctype: "Timesheet",
				filters: { employee, start_date: frappe.datetime.get_today(), docstatus: 0 },
				fields: ["name"],
				limit_page_length: 1,
			},
		});
		const row = {
			project: options.project,
			task: options.task.name,
			from_time: options.fromTime,
			to_time: options.toTime,
			hours: options.hours,
			activity_type: options.activityType,
		};
		const name = response.message?.[0]?.name;
		if (!name) {
			return frappe.call({
				method: "frappe.client.insert",
				args: { doc: { doctype: "Timesheet", employee, time_logs: [row] } },
			});
		}
		const existing = await frappe.call({
			method: "frappe.client.get",
			args: { doctype: "Timesheet", name },
		});
		existing.message.time_logs.push(row);
		return frappe.call({ method: "frappe.client.save", args: { doc: existing.message } });
	};
})();
