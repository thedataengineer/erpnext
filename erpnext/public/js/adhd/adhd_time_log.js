// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors

(() => {
	const FocusPanel = erpnext.adhd.FocusPanel;
	const originalRenderTasks = FocusPanel.prototype._renderTasks;
	const originalTimerStart = FocusPanel.prototype._timerStart;
	const originalTimerReset = FocusPanel.prototype._timerReset;
	const originalTimerComplete = FocusPanel.prototype._timerComplete;

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

	FocusPanel.prototype._timerStart = function () {
		if (this.timerMode === "work" && !this._sessionStartedAt) {
			this._sessionStartedAt = frappe.datetime.now_datetime();
			this._sessionMinutes = this.timerSeconds / 60;
		}
		return originalTimerStart.call(this);
	};

	FocusPanel.prototype._timerReset = function (...args) {
		this._sessionStartedAt = null;
		this._sessionMinutes = null;
		return originalTimerReset.apply(this, args);
	};

	FocusPanel.prototype._timerComplete = function () {
		const completedWork = this.timerMode === "work";
		const options =
			completedWork && this.activeTask
				? {
						fromTime:
							this._sessionStartedAt ||
							frappe.datetime.add_minutes(
								frappe.datetime.now_datetime(),
								-(this._sessionMinutes || 25),
							),
						toTime: frappe.datetime.now_datetime(),
						hours: (this._sessionMinutes || 25) / 60,
						task: this.activeTask,
						project: this.activeTask.project || null,
						activityType: frappe.boot.adhd_default_activity_type || "Execution",
					}
				: null;
		const result = originalTimerComplete.call(this);
		this._sessionStartedAt = null;
		this._sessionMinutes = null;
		if (options && frappe.boot.adhd_mode) this._renderTimeLogBanner(options);
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
				await this._saveTimeLog(options);
				frappe.show_alert({
					message: __("Time logged on {0}", [options.task.subject || options.task.name]),
					indicator: "green",
				});
				banner.remove();
			} catch (error) {
				event.currentTarget.disabled = false;
				console.warn("[ADHD Focus Panel] Could not log time", error);
				frappe.show_alert({ message: __("Could not log time. Try again."), indicator: "red" });
			}
		});
		setTimeout(() => banner.remove(), 5 * 60 * 1000);
	};

	FocusPanel.prototype._saveTimeLog = async function (options) {
		const employee = frappe.boot.employee_name || null;
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
