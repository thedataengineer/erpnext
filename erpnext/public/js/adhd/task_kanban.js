// Copyright (c) 2024, ERPNext Contributors
// ADHD-Friendly Mode: Task Kanban Board
// License: GNU General Public License v3. See license.txt

frappe.provide("erpnext.adhd");

// The board is the "Task Kanban View" switch in ADHD Settings. Without that module it stays as it was.
function isTaskKanbanOn() {
	const settings = erpnext.adhd.ADHDSettings || window.ADHDSettings;
	return !settings || Boolean(settings.get("task_kanban"));
}

erpnext.adhd.TaskKanban = class TaskKanban {
	constructor(wrapper) {
		this.wrapper = wrapper;
		this.tasks = [];
		this.columns = [
			{ id: "Open", label: "📋 To Do", color: "#64748b" },
			{ id: "Working", label: "⚡ In Progress", color: "#3b82f6" },
			{ id: "Pending Review", label: "👀 Review", color: "#f59e0b" },
			{ id: "Completed", label: "✅ Done", color: "#10b981" },
		];
		this.draggedTask = null;
		// switched off in ADHD Settings: build nothing and ask for nothing (the page says why)
		if (!isTaskKanbanOn()) return;
		this._render();
		this._loadTasks();
	}

	_render() {
		$(this.wrapper).empty().append(`
			<div class="adhd-kanban-wrapper">
				<div class="adhd-kanban-toolbar">
					<div class="adhd-kanban-title">
						<span class="adhd-kanban-icon">🗂</span>
						<span>${__("Task Board")}</span>
					</div>
					<div class="adhd-kanban-actions">
						<input type="text" id="adhd-kanban-search"
							class="adhd-kanban-search"
							placeholder="🔍 ${__("Search tasks…")}">
						<select id="adhd-kanban-project" class="adhd-kanban-filter">
							<option value="">${__("All Projects")}</option>
						</select>
						<button class="adhd-btn adhd-btn-primary" id="adhd-kanban-add">
							+ ${__("Add Task")}
						</button>
					</div>
				</div>

				<div class="adhd-kanban-board" id="adhd-kanban-board">
					${this.columns
						.map(
							(col) => `
						<div class="adhd-kanban-col" data-status="${col.id}" style="--col-color: ${col.color}">
							<div class="adhd-kanban-col-header">
								<span class="adhd-kanban-col-title">${col.label}</span>
								<span class="adhd-kanban-col-count" id="col-count-${col.id}">0</span>
							</div>
							<div class="adhd-kanban-cards" id="col-${col.id.replace(" ", "-")}">
								<div class="adhd-kanban-loading">Loading…</div>
							</div>
							<button class="adhd-kanban-add-card" data-status="${col.id}">
								+ ${__("Add")}
							</button>
						</div>
					`
						)
						.join("")}
				</div>

				<!-- Quick Add Form (hidden by default) -->
				<div class="adhd-quick-add-form" id="adhd-quick-add-form" style="display:none">
					<div class="adhd-quick-add-inner">
						<h4 class="adhd-quick-add-title">${__("Quick Add Task")}</h4>
						<input type="text" id="adhd-qa-subject" class="adhd-qa-input"
							placeholder="${__("What needs to be done?")}">
						<div class="adhd-qa-row">
							<input type="date" id="adhd-qa-date" class="adhd-qa-input adhd-qa-date">
							<select id="adhd-qa-priority" class="adhd-qa-select">
								<option value="Low">${__("Low Priority")}</option>
								<option value="Medium" selected>${__("Medium Priority")}</option>
								<option value="High">${__("High Priority")}</option>
								<option value="Urgent">${__("🔴 Urgent")}</option>
							</select>
							<select id="adhd-qa-project" class="adhd-qa-select">
								<option value="">${__("No Project")}</option>
							</select>
						</div>
						<div class="adhd-qa-actions">
							<button class="adhd-btn adhd-btn-primary" id="adhd-qa-save">${__("Add Task")}</button>
							<button class="adhd-btn adhd-btn-ghost" id="adhd-qa-cancel">${__("Cancel")}</button>
						</div>
					</div>
				</div>
			</div>
		`);

		this._bindEvents();
		this._loadProjects();
	}

	_bindEvents() {
		// Add task button
		$(this.wrapper).on("click", "#adhd-kanban-add", () => {
			this._showQuickAdd("Open");
		});

		// Column-level add buttons
		$(this.wrapper).on("click", ".adhd-kanban-add-card", (e) => {
			const status = $(e.currentTarget).data("status");
			this._showQuickAdd(status);
		});

		// Quick add form
		$(this.wrapper).on("click", "#adhd-qa-save", () => this._saveQuickAdd());
		$(this.wrapper).on("click", "#adhd-qa-cancel", () => this._hideQuickAdd());

		// Enter key in subject field
		$(this.wrapper).on("keydown", "#adhd-qa-subject", (e) => {
			if (e.key === "Enter") this._saveQuickAdd();
			if (e.key === "Escape") this._hideQuickAdd();
		});

		// Search filter
		$(this.wrapper).on("input", "#adhd-kanban-search", (e) => {
			this._filterCards(e.target.value);
		});

		// Project filter
		$(this.wrapper).on("change", "#adhd-kanban-project", () => {
			this._renderCards();
		});
	}

	refresh() {
		return this._loadTasks();
	}

	async _loadTasks() {
		// the board on screen can outlive the switch: its timers and buttons must not fetch after it is off
		if (!isTaskKanbanOn()) return;
		try {
			const result = await frappe.call({
				method: "frappe.client.get_list",
				args: {
					doctype: "Task",
					filters: [["status", "in", ["Open", "Working", "Pending Review", "Completed"]]],
					fields: [
						"name",
						"subject",
						"status",
						"priority",
						"exp_end_date",
						"project",
						"progress",
						"color",
					],
					order_by: "modified desc",
					limit_page_length: 100,
				},
			});

			this.tasks = (result && result.message) || [];
			this._renderCards();
		} catch (e) {
			console.error("[TaskKanban] Error loading tasks:", e);
		}
	}

	async _loadProjects() {
		try {
			const result = await frappe.call({
				method: "frappe.client.get_list",
				args: {
					doctype: "Project",
					fields: ["name"],
					limit_page_length: 50,
				},
			});

			const projects = (result && result.message) || [];
			const sel1 = document.getElementById("adhd-kanban-project");
			const sel2 = document.getElementById("adhd-qa-project");

			projects.forEach((p) => {
				[sel1, sel2].forEach((sel) => {
					if (sel) {
						const opt = document.createElement("option");
						opt.value = p.name;
						opt.textContent = p.name;
						sel.appendChild(opt);
					}
				});
			});
		} catch (e) {
			// Silently ignore — projects are optional
		}
	}

	_renderCards() {
		const projectFilter = document.getElementById("adhd-kanban-project")?.value || "";
		const filtered = projectFilter ? this.tasks.filter((t) => t.project === projectFilter) : this.tasks;

		this.columns.forEach((col) => {
			const colTasks = filtered.filter((t) => t.status === col.id);
			const colEl = document.getElementById(`col-${col.id.replace(" ", "-")}`);
			const countEl = document.getElementById(`col-count-${col.id}`);

			if (countEl) countEl.textContent = colTasks.length;

			if (!colEl) return;
			colEl.innerHTML = "";

			if (!colTasks.length) {
				colEl.innerHTML = `<div class="adhd-kanban-empty">${this._emptyMessage(col.id)}</div>`;
				return;
			}

			const sorted = this._sortByPriority(colTasks);
			sorted.forEach((task) => {
				const card = this._buildCard(task);
				colEl.appendChild(card);
				this._attachDragEvents(card, task);
			});
		});

		this._setupDropZones();
	}

	_sortByPriority(tasks) {
		const order = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
		return [...tasks].sort((a, b) => (order[a.priority] ?? 99) - (order[b.priority] ?? 99));
	}

	_emptyMessage(status) {
		const msgs = {
			Open: "🙌 No pending tasks!",
			Working: "💤 Nothing in progress",
			"Pending Review": "👌 Nothing waiting for review",
			Completed: "Start completing tasks to see them here",
		};
		return msgs[status] || "Empty";
	}

	_buildCard(task) {
		const card = document.createElement("div");
		card.className = `adhd-kanban-card priority-${(task.priority || "low").toLowerCase()}`;
		card.setAttribute("draggable", true);
		card.dataset.taskName = task.name;

		const priorityEmoji = { Urgent: "🔴", High: "🟠", Medium: "🟡", Low: "🟢" };
		const emoji = priorityEmoji[task.priority] || "⚪";

		const now = new Date();
		const dueDate = task.exp_end_date ? new Date(task.exp_end_date) : null;
		const isOverdue = dueDate && dueDate < now && task.status !== "Completed";
		const dueSoon = dueDate && dueDate - now < 2 * 24 * 60 * 60 * 1000 && !isOverdue;

		const dueHtml = dueDate
			? `<div class="adhd-card-due ${isOverdue ? "overdue" : dueSoon ? "due-soon" : ""}">
					${isOverdue ? "⚠" : "📅"} ${frappe.datetime.prettyDate(task.exp_end_date)}
				</div>`
			: "";

		const progressHtml =
			task.progress > 0
				? `<div class="adhd-card-progress">
					<div class="adhd-card-progress-fill" style="width:${task.progress}%"></div>
					<span class="adhd-card-progress-label">${task.progress}%</span>
				</div>`
				: "";

		// subject and project are typed by people: escape everything that goes into the markup
		const esc = (value) => frappe.utils.escape_html(String(value ?? ""));
		const name = esc(task.name);
		card.innerHTML = `
			<div class="adhd-card-header">
				<span class="adhd-card-priority">${emoji}</span>
				<span class="adhd-card-drag-handle" title="${__("Drag to move")}">⠿</span>
			</div>
			<div class="adhd-card-subject">
				<a href="${esc(frappe.utils.get_form_link("Task", task.name))}" title="${__("Open task")}">
					${esc(task.subject)}
				</a>
			</div>
			${task.project ? `<div class="adhd-card-project">📁 ${esc(task.project)}</div>` : ""}
			${dueHtml}
			${progressHtml}
			<div class="adhd-card-actions">
				<button class="adhd-card-btn" data-action="done" data-task="${name}"
					title="${__("Mark as done")}">✓</button>
				<button class="adhd-card-btn" data-action="open" data-task="${name}"
					title="${__("Open full form")}">↗</button>
			</div>
		`;

		card.addEventListener("click", (e) => {
			const btn = e.target.closest("[data-action]");
			if (!btn) return;

			const action = btn.dataset.action;
			const taskName = btn.dataset.task;

			if (action === "done") {
				this._moveTask(taskName, "Completed", card);
				card.classList.add("adhd-card-completing");
				setTimeout(() => this._loadTasks(), 700);
			} else if (action === "open") {
				frappe.set_route("Form", "Task", taskName);
			}
		});

		return card;
	}

	_attachDragEvents(card, task) {
		card.addEventListener("dragstart", (e) => {
			this.draggedTask = task;
			card.classList.add("dragging");
			e.dataTransfer.effectAllowed = "move";
		});

		card.addEventListener("dragend", () => {
			card.classList.remove("dragging");
			document
				.querySelectorAll(".adhd-kanban-cards.drag-over")
				.forEach((el) => el.classList.remove("drag-over"));
		});
	}

	_setupDropZones() {
		document.querySelectorAll(".adhd-kanban-cards").forEach((zone) => {
			zone.addEventListener("dragover", (e) => {
				e.preventDefault();
				zone.classList.add("drag-over");
			});

			zone.addEventListener("dragleave", () => {
				zone.classList.remove("drag-over");
			});

			zone.addEventListener("drop", (e) => {
				e.preventDefault();
				zone.classList.remove("drag-over");

				if (!this.draggedTask) return;

				const col = zone.closest(".adhd-kanban-col");
				if (!col) return;

				const newStatus = col.dataset.status;
				if (newStatus && newStatus !== this.draggedTask.status) {
					const card = document.querySelector(
						`.adhd-kanban-card[data-task-name="${CSS.escape(this.draggedTask.name)}"]`
					);
					this._moveTask(this.draggedTask.name, newStatus, card);
				}

				this.draggedTask = null;
			});
		});
	}

	async _moveTask(taskName, newStatus, cardElement) {
		try {
			await frappe.call({
				method: "frappe.client.set_value",
				args: { doctype: "Task", name: taskName, fieldname: "status", value: newStatus },
			});

			// Update local state
			const task = this.tasks.find((t) => t.name === taskName);
			if (task) task.status = newStatus;

			if (newStatus === "Completed") {
				const title = task?.subject || taskName;
				erpnext.adhd.showDoneWell?.(__('Task "{0}" done.', [title]), cardElement);
			}
			setTimeout(() => this._renderCards(), newStatus === "Completed" ? 450 : 0);
		} catch (e) {
			frappe.msgprint(__("Could not update task status. Please try again."));
		}
	}

	_filterCards(query) {
		const q = query.toLowerCase().trim();
		document.querySelectorAll(".adhd-kanban-card").forEach((card) => {
			const text = card.querySelector(".adhd-card-subject")?.textContent.toLowerCase() || "";
			card.style.display = !q || text.includes(q) ? "" : "none";
		});
	}

	getState() {
		return {
			columns: this.columns.map((column) => ({
				name: column.id,
				cardCount: this.tasks.filter((task) => task.status === column.id).length,
			})),
			dragActive: Boolean(this.draggedTask),
		};
	}

	_showQuickAdd(defaultStatus) {
		this._currentAddStatus = defaultStatus;
		const form = document.getElementById("adhd-quick-add-form");
		if (form) {
			form.style.display = "flex";
			document.getElementById("adhd-qa-subject")?.focus();
		}
	}

	_hideQuickAdd() {
		const form = document.getElementById("adhd-quick-add-form");
		if (form) {
			form.style.display = "none";
			document.getElementById("adhd-qa-subject").value = "";
		}
	}

	async _saveQuickAdd() {
		const subject = document.getElementById("adhd-qa-subject")?.value?.trim();
		if (!subject) {
			document.getElementById("adhd-qa-subject")?.focus();
			return;
		}

		const priority = document.getElementById("adhd-qa-priority")?.value || "Medium";
		const project = document.getElementById("adhd-qa-project")?.value || null;
		const dueDate = document.getElementById("adhd-qa-date")?.value || null;
		const status = this._currentAddStatus || "Open";

		try {
			const result = await frappe.call({
				method: "frappe.client.insert",
				args: {
					doc: {
						doctype: "Task",
						subject,
						status,
						priority,
						project: project || undefined,
						exp_end_date: dueDate || undefined,
					},
				},
			});

			this._hideQuickAdd();
			frappe.show_alert({ message: `✅ Task "${subject}" created!`, indicator: "green" }, 3);
			this._loadTasks();
		} catch (e) {
			frappe.msgprint(__("Could not create task. Please check required fields."));
		}
	}
};

// The page itself lives in erpnext/setup/page/adhd_task_board/. Frappe builds it from that
// standard Page record and calls on_page_load/on_page_show there; nothing may be assigned to
// frappe.pages["adhd-task-board"] here, or Frappe treats the page as already created.
