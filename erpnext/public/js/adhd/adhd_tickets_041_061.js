// ADHD-041 through ADHD-061: module-specific context and completion aids.
frappe.provide("erpnext.adhd");

(() => {
	// The mode can be switched on or off after this file loads, so every handler checks it when it runs.
	const adhdOn = () => Boolean(frappe.boot && frappe.boot.adhd_mode);

	const esc = (value) => frappe.utils.escape_html(String(value ?? ""));
	const SYSTEM_DATETIME_FORMAT = "YYYY-MM-DD HH:mm:ss";
	const systemTimeZone = () => frappe.boot?.time_zone?.system;
	// Datetime values on a document are in the system time zone, not the browser's.
	const datetimeMs = (value) => {
		const text = String(value);
		const zone = systemTimeZone();
		if (zone && typeof moment !== "undefined" && moment.tz) return moment.tz(text, zone).valueOf();
		return new Date(text.replace(" ", "T")).getTime();
	};
	const systemDatetimeAt = (ms) => {
		const zone = systemTimeZone();
		const value = moment(ms);
		return (zone && value.tz ? value.tz(zone) : value).format(SYSTEM_DATETIME_FORMAT);
	};
	const plainText = (value) =>
		frappe.utils.strip_html
			? frappe.utils.strip_html(value)
			: String(value ?? "").replace(/<[^>]*>/g, " ");
	const remove = (frm, selector) => $(frm.wrapper).find(selector).remove();
	const prepend = (frm, node) => $(frm.wrapper).find(".form-layout").first().prepend(node);
	const getCount = async (doctype, filters) => {
		const response = await frappe.call({
			method: "frappe.client.get_count",
			args: { doctype, filters },
		});
		return cint(response.message);
	};

	function panel(frm, className, html) {
		remove(frm, `.${className.split(" ")[0]}`);
		const $node = $(`<div class="${className}">${html}</div>`);
		prepend(frm, $node);
		return $node;
	}

	// ADHD-041
	async function renderBomAncestry(frm) {
		remove(frm, ".adhd-bom-breadcrumb");
		if (!adhdOn() || frm.is_new()) return;
		const response = await frappe.call({
			method: "erpnext.manufacturing.services.adhd_bom_ancestry.get_bom_ancestry",
			args: { bom_name: frm.doc.name, max_depth: 3 },
		});
		const ancestors = response.message || [];
		const open = localStorage.getItem("adhd_bom_breadcrumb_open") !== "0";
		const crumbs = ancestors
			.map(
				(row) =>
					`<a href="/app/bom/${encodeURIComponent(row.bom)}">${esc(row.item_name || row.item)}</a>`
			)
			.concat(`<strong>${esc(frm.doc.item_name || frm.doc.item || frm.doc.name)}</strong>`)
			.join('<span class="adhd-separator">›</span>');
		const body = ancestors.length
			? crumbs
			: `<span class="text-muted">${__("This BOM has no submitted parent.")}</span>`;
		const $node = panel(
			frm,
			"adhd-bom-breadcrumb",
			`<div class="adhd-panel-heading"><span>📍 ${__("BOM hierarchy")}</span>
				<button type="button" class="btn btn-xs btn-default adhd-toggle">${open ? __("Hide") : __("Show")}</button>
			</div><div class="adhd-panel-body" ${open ? "" : 'style="display:none"'}>${body}</div>`
		);
		$node.find(".adhd-toggle").on("click", function () {
			const $body = $node.find(".adhd-panel-body");
			const shouldOpen = !$body.is(":visible");
			$body.toggle(shouldOpen);
			$(this).text(shouldOpen ? __("Hide") : __("Show"));
			localStorage.setItem("adhd_bom_breadcrumb_open", shouldOpen ? "1" : "0");
		});
	}
	frappe.ui.form.on("BOM", { refresh: renderBomAncestry });

	// ADHD-042
	async function getJobCardCounts(workOrder) {
		// Every status except Submitted, Completed and Cancelled still has work or a stock entry pending.
		const [open, total] = await Promise.all([
			getCount("Job Card", {
				work_order: workOrder,
				docstatus: ["!=", 2],
				status: [
					"in",
					[
						"Open",
						"Work In Progress",
						"Partially Transferred",
						"Material Transferred",
						"On Hold",
						"To Manufacture",
					],
				],
			}),
			getCount("Job Card", { work_order: workOrder, docstatus: ["!=", 2] }),
		]);
		return { open, total };
	}

	function showNextAction(frm, message, label, action) {
		const $node = panel(
			frm,
			"adhd-work-order-next",
			`<span>▶</span><span class="adhd-flex">${esc(message)}</span>${
				label ? `<button type="button" class="btn btn-xs btn-primary">${esc(label)}</button>` : ""
			}`
		);
		if (label) $node.find("button").on("click", action);
	}

	async function renderWorkOrderNext(frm) {
		remove(frm, ".adhd-work-order-next");
		if (!adhdOn()) return;
		const status = frm.doc.status;
		if (status === "Draft") {
			showNextAction(frm, __("Submit this Work Order to start production."));
		} else if (
			["Submitted", "Not Started"].includes(status) &&
			!flt(frm.doc.produced_qty) &&
			// The standard Create Job Card button needs operations and a quantity not yet covered by Job Cards.
			(frm.doc.operations || []).length &&
			frm.doc.__onload?.show_create_job_card_button
		) {
			showNextAction(frm, __("Create Job Cards to begin operations."), __("Create Job Cards"), () =>
				frm.trigger("make_job_card")
			);
		} else if (status === "In Process") {
			const { open, total } = await getJobCardCounts(frm.doc.name);
			if (open) {
				showNextAction(
					frm,
					__("{0} of {1} Job Cards remain open.", [open, total]),
					__("View Job Cards"),
					() => {
						frappe.route_options = { work_order: frm.doc.name };
						frappe.set_route("List", "Job Card");
					}
				);
			} else if (total) {
				showNextAction(
					frm,
					__("All operations are complete. Create the manufacture entry to finish."),
					__("Finish Work Order"),
					() => erpnext.work_order.make_se(frm, "Manufacture")
				);
			}
		} else if (status === "Completed") {
			showNextAction(
				frm,
				__("Work Order complete. Review the finished-goods Stock Entry."),
				__("View Stock Entries"),
				() => {
					frappe.route_options = { work_order: frm.doc.name };
					frappe.set_route("List", "Stock Entry");
				}
			);
		}
	}
	frappe.ui.form.on("Work Order", { refresh: renderWorkOrderNext, after_save: renderWorkOrderNext });

	// ADHD-043
	function productionPlanSummary(doc) {
		const po = doc.po_items || [];
		const mr = doc.mr_items || [];
		const all = [...po, ...mr];
		const dates = all
			.map((row) => row.planned_start_date || row.schedule_date)
			.filter(Boolean)
			.sort();
		return {
			count: new Set(all.map((row) => row.item_code).filter(Boolean)).size,
			salesOrders: new Set(po.map((row) => row.sales_order).filter(Boolean)).size,
			qty: all.reduce((sum, row) => sum + flt(row.planned_qty ?? row.quantity ?? row.qty), 0),
			date: dates[0] || null,
			rows: all.length,
		};
	}

	function renderProductionPlanSummary(frm) {
		remove(frm, ".adhd-plan-summary");
		if (!adhdOn()) return;
		const summary = productionPlanSummary(frm.doc);
		if (!summary.rows) return;
		const source = summary.salesOrders
			? __("{0} Sales Order(s)", [summary.salesOrders])
			: (frm.doc.mr_items || []).length
			? __("Material Requests")
			: __("manual entry");
		const html = `<span>📦 <strong>${summary.count}</strong> ${__("item types")}</span>
			<span>🛒 ${esc(source)}</span>
			<span>🔢 ${__("Total qty")}: <strong>${format_number(summary.qty)}</strong></span>
			<span>📅 ${__("Target start")}: <strong>${
			summary.date ? esc(frappe.datetime.str_to_user(summary.date)) : "—"
		}</strong></span>`;
		const $target = $(frm.wrapper).find('[data-fieldname="po_items"]').first();
		const $node = $(`<div class="adhd-plan-summary">${html}</div>`);
		$target.length ? $target.before($node) : prepend(frm, $node);
	}
	frappe.ui.form.on("Production Plan", {
		refresh: renderProductionPlanSummary,
		after_save: renderProductionPlanSummary,
	});

	// ADHD-044
	const timerKey = (name) => `adhd_timer_${name}`;
	function elapsedParts(start, now = Date.now()) {
		const seconds = Math.max(0, Math.floor((now - new Date(start).getTime()) / 1000));
		return {
			hours: Math.floor(seconds / 3600),
			minutes: Math.floor((seconds % 3600) / 60),
			seconds: seconds % 60,
			totalSeconds: seconds,
		};
	}

	function renderJobCardTimer(frm) {
		remove(frm, ".adhd-time-toggle");
		clearInterval(frm._adhdTimerInterval);
		frm._adhdTimerInterval = null;
		if (!adhdOn()) return;
		// Time is logged on a saved draft Job Card (docstatus 0); a submitted card locks its time logs.
		if (
			frm.is_new() ||
			frm.doc.docstatus !== 0 ||
			["Completed", "Submitted", "Cancelled"].includes(frm.doc.status)
		) {
			localStorage.removeItem(timerKey(frm.doc.name));
			return;
		}
		let stored;
		try {
			stored = JSON.parse(localStorage.getItem(timerKey(frm.doc.name)) || "null");
		} catch {
			localStorage.removeItem(timerKey(frm.doc.name));
		}
		const $node = panel(
			frm,
			`adhd-time-toggle${stored ? " adhd-time-toggle--running" : ""}`,
			`<button type="button" class="btn btn-primary">${
				stored ? "⏹ " + __("Stop Work") : "▶ " + __("Start Work")
			}</button>
				<span class="adhd-timer-elapsed"></span>`
		);
		const tick = () => {
			const active = JSON.parse(localStorage.getItem(timerKey(frm.doc.name)) || "null");
			if (!active) return $node.find(".adhd-timer-elapsed").text("");
			const value = elapsedParts(active.start);
			$node
				.find(".adhd-timer-elapsed")
				.text(
					`${String(value.hours).padStart(2, "0")}:${String(value.minutes).padStart(
						2,
						"0"
					)}:${String(value.seconds).padStart(2, "0")}`
				);
		};
		const stopTicking = () => {
			clearInterval(frm._adhdTimerInterval);
			frm._adhdTimerInterval = null;
		};
		const startTicking = () => {
			stopTicking();
			frm._adhdTimerInterval = setInterval(() => {
				// A form page is hidden, not destroyed, on a route change, so stop when it is no longer shown.
				if (!adhdOn() || !$(frm.wrapper).is(":visible")) return stopTicking();
				tick();
			}, 1000);
		};
		if (stored) {
			tick();
			startTicking();
		}
		$node.find("button").on("click", async function () {
			const key = timerKey(frm.doc.name);
			const active = JSON.parse(localStorage.getItem(key) || "null");
			if (!active) {
				const start = new Date().toISOString();
				localStorage.setItem(key, JSON.stringify({ start }));
				$(this).text(`⏹ ${__("Stop Work")}`);
				$node.addClass("adhd-time-toggle--running");
				tick();
				startTicking();
				return;
			}
			localStorage.removeItem(key);
			stopTicking();
			const duration = elapsedParts(active.start).totalSeconds;
			if (duration < 30) {
				frappe.show_alert({
					message: __("Session too short to log (under 30 seconds)."),
					indicator: "orange",
				});
				renderJobCardTimer(frm);
				return;
			}
			const row = frappe.model.add_child(frm.doc, "Job Card Time Log", "time_logs");
			// Datetime fields hold "YYYY-MM-DD HH:mm:ss" in the system time zone, not an ISO UTC instant.
			await frappe.model.set_value(row.doctype, row.name, {
				from_time: systemDatetimeAt(new Date(active.start).getTime()),
				to_time: systemDatetimeAt(Date.now()),
				time_in_mins: duration / 60,
			});
			frm.refresh_field("time_logs");
			await frm.save();
			frappe.show_alert({
				message: __("Time logged: {0} minutes.", [Math.round(duration / 60)]),
				indicator: "green",
			});
			renderJobCardTimer(frm);
		});
	}
	frappe.ui.form.on("Job Card", { refresh: renderJobCardTimer });

	// ADHD-045. Work Order cards live on Shop Floor in this ERPNext version.
	function isBlockedJobCard(jobCard, now = Date.now()) {
		if (!jobCard.expected_end_date) return false;
		const end = datetimeMs(jobCard.expected_end_date);
		return Number.isFinite(end) && now - end > 2 * 60 * 60 * 1000;
	}
	async function markBlockedShopFloor(shopFloor) {
		const $cards = shopFloor.board_container?.find(".sf-wo-card[data-name]");
		$cards?.removeClass("adhd-work-order-card--blocked").find(".adhd-blocked-badge").remove();
		if (!adhdOn()) return;
		const names = [
			...new Set(
				$cards
					?.map((_, card) => card.dataset.name)
					.get()
					.filter(Boolean) || []
			),
		];
		if (!names.length) return;
		const requestId = (shopFloor._adhdBlockedRequest || 0) + 1;
		shopFloor._adhdBlockedRequest = requestId;
		const response = await frappe.call({
			method: "frappe.client.get_list",
			args: {
				doctype: "Job Card",
				filters: [
					["work_order", "in", names],
					["status", "in", ["Open", "Work In Progress"]],
				],
				fields: ["name", "work_order", "expected_end_date"],
				limit_page_length: 500,
			},
		});
		if (requestId !== shopFloor._adhdBlockedRequest) return;
		const blocked = new Set(
			(response.message || []).filter(isBlockedJobCard).map((row) => row.work_order)
		);
		for (const workOrder of blocked) {
			shopFloor.board_container
				.find(".sf-wo-card[data-name]")
				.filter((_, card) => card.dataset.name === workOrder)
				.addClass("adhd-work-order-card--blocked")
				.prepend('<span class="adhd-blocked-badge">🚫 Blocked</span>');
		}
	}
	if (frappe.ui.ShopFloor && !frappe.ui.ShopFloor.prototype._adhdBlockedPatched) {
		const originalRenderBoard = frappe.ui.ShopFloor.prototype.render_board;
		frappe.ui.ShopFloor.prototype.render_board = function (...args) {
			const result = originalRenderBoard.apply(this, args);
			markBlockedShopFloor(this).catch(() => null);
			return result;
		};
		frappe.ui.ShopFloor.prototype._adhdBlockedPatched = true;
	}

	// ADHD-046
	function deadlineState(deadline, today) {
		if (!deadline) return { text: __("No deadline set"), tone: "muted" };
		const days = frappe.datetime.get_diff(deadline, today);
		if (days < 0) return { text: __("{0} days overdue", [Math.abs(days)]), tone: "danger" };
		return { text: __("{0} days left", [days]), tone: days <= 7 ? "warning" : "normal" };
	}

	async function renderProjectHealth(frm) {
		remove(frm, ".adhd-project-health");
		if (!adhdOn() || frm.is_new()) return;
		const today = frappe.datetime.get_today();
		// One filter set drives both the number and the list it links to, so the two always agree.
		const overdueFilters = {
			project: frm.doc.name,
			status: ["not in", ["Completed", "Cancelled"]],
			exp_end_date: ["<", today],
		};
		const routeQuery = (filters) =>
			Object.entries(filters)
				.map(
					([field, value]) =>
						`${field}=${encodeURIComponent(
							typeof value === "string" ? value : JSON.stringify(value)
						)}`
				)
				.join("&");
		const [overdue, unassigned] = await Promise.all([
			getCount("Task", overdueFilters),
			getCount("Task", {
				project: frm.doc.name,
				status: ["not in", ["Completed", "Cancelled"]],
				_assign: ["is", "not set"],
			}),
		]);
		const deadline = deadlineState(frm.doc.expected_end_date, today);
		const metric = (label, value, tone = "", href = "") => {
			const rendered = href ? `<a href="${href}">${esc(value)}</a>` : esc(value);
			return `<div><small>${esc(label)}</small><strong class="${
				tone ? `adhd-${tone}` : ""
			}">${rendered}</strong></div>`;
		};
		const project = encodeURIComponent(frm.doc.name);
		panel(
			frm,
			"adhd-project-health",
			`<h5>🏥 ${__("Project Health")}</h5><div class="adhd-metric-grid">
				${metric(__("Overdue Tasks"), overdue, overdue ? "danger" : "", `/app/task?${routeQuery(overdueFilters)}`)}
				${metric(
					__("Unassigned Tasks"),
					unassigned,
					unassigned ? "warning" : "",
					`/app/task?project=${project}&_assign=`
				)}
				${metric(__("% Complete"), `${Math.round(flt(frm.doc.percent_complete))}%`)}
				${metric(__("Deadline"), deadline.text, deadline.tone)}
			</div>`
		);
	}
	frappe.ui.form.on("Project", { refresh: renderProjectHealth });

	// ADHD-047
	const LAST_ACTIVITY_KEY = "adhd_last_activity_type";
	function persistTimesheetActivity(frm) {
		if (!adhdOn()) return;
		const row = (frm.doc.time_logs || []).find((item) => item.activity_type);
		if (row) localStorage.setItem(LAST_ACTIVITY_KEY, row.activity_type);
	}
	async function prefillTimesheet(frm) {
		if (!adhdOn() || !frm.is_new()) return;
		if (!(frm.doc.time_logs || []).length) {
			frappe.model.add_child(frm.doc, "Timesheet Detail", "time_logs");
		}
		const row = frm.doc.time_logs[0];
		const last = localStorage.getItem(LAST_ACTIVITY_KEY);
		if (last && !row.activity_type)
			await frappe.model.set_value(row.doctype, row.name, "activity_type", last);
		const previous = (frappe.route_history || []).at(-2);
		if (previous?.[0] === "Form" && previous[1] === "Task" && previous[2] && !row.task) {
			const result = await frappe.db.get_value("Task", previous[2], ["project", "subject"]);
			const task = result.message || {};
			await frappe.model.set_value(row.doctype, row.name, {
				task: previous[2],
				project: row.project || task.project,
			});
		}
		frm.refresh_field("time_logs");
		window.setTimeout(() => {
			const $row = frm.fields_dict.time_logs?.grid?.grid_rows_by_docname?.[row.name]?.$row;
			$row?.find(
				'[data-fieldname="activity_type"],[data-fieldname="task"],[data-fieldname="project"]'
			).addClass("adhd-prefilled");
		}, 0);
	}
	frappe.ui.form.on("Timesheet", {
		onload_post_render: prefillTimesheet,
		after_save: persistTimesheetActivity,
	});

	// ADHD-048. CRM Note is a child table in this branch, so reference its parent document.
	const PROMISE_REGEX =
		/\b(will|i['’]ll|i will|send|call back|follow[- ]?up|schedule|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|eod|end of day|end of week|\d{1,2}[/-]\d{1,2}))\b/i;
	const DATE_REGEX =
		/\b(tomorrow|(?:next|by)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?|(?:by\s+)?(eod|end of day|end of week))\b/i;
	// Numeric dates follow the user's date format: day first for dd-mm-yyyy style, month first otherwise.
	function userDateIsDayFirst() {
		const format = String(frappe.datetime?.get_user_date_fmt?.() || "").toLowerCase();
		const day = format.indexOf("dd");
		return day !== -1 && (format.indexOf("mm") === -1 || day < format.indexOf("mm"));
	}
	function resolvePromiseDate(
		phrase,
		today = frappe.datetime.get_today(),
		dayFirst = userDateIsDayFirst()
	) {
		if (!phrase) return null;
		const lower = phrase.toLowerCase().replace(/^by\s+/, "");
		if (lower === "tomorrow") return frappe.datetime.add_days(today, 1);
		if (lower === "eod" || lower === "end of day") return today;
		if (lower === "next week") return frappe.datetime.add_days(today, 7);
		const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
		const day = weekdays.findIndex((name) => lower.includes(name));
		if (day >= 0) {
			const current = new Date(`${today}T00:00:00`).getDay();
			let offset = (day - current + 7) % 7;
			if (!offset || lower.startsWith("next ")) offset += 7;
			return frappe.datetime.add_days(today, offset);
		}
		if (lower === "end of week") {
			const current = new Date(`${today}T00:00:00`).getDay();
			return frappe.datetime.add_days(today, current <= 5 ? 5 - current : 7 - current + 5);
		}
		const numeric = /(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/.exec(lower);
		if (!numeric) return null;
		const [dayOfMonth, month] = dayFirst
			? [Number(numeric[1]), Number(numeric[2])]
			: [Number(numeric[2]), Number(numeric[1])];
		let year = numeric[3] || today.slice(0, 4);
		if (year.length === 2) year = `20${year}`;
		if (year.length !== 4) return null;
		// Reject impossible dates such as 25/12 read as month/day, or 31/02, instead of building an invalid one.
		const date = new Date(Date.UTC(Number(year), month - 1, dayOfMonth));
		if (
			date.getUTCFullYear() !== Number(year) ||
			date.getUTCMonth() !== month - 1 ||
			date.getUTCDate() !== dayOfMonth
		) {
			return null;
		}
		return `${year}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
	}
	function extractCommitment(note) {
		const promise = PROMISE_REGEX.exec(note || "");
		if (!promise) return null;
		const start = Math.max(0, promise.index - 20);
		const description = note
			.slice(start, Math.min(note.length, promise.index + 100))
			.replace(/\s+/g, " ")
			.trim();
		const dateMatch = DATE_REGEX.exec(note);
		return { description, date: resolvePromiseDate(dateMatch?.[0]) };
	}
	function attachCommitmentDetector(dialog, frm) {
		if (!adhdOn() || !dialog || !frm) return;
		const field = dialog.get_field("note");
		if (!field?.$wrapper) return;
		const render = () => {
			dialog.$wrapper.find(".adhd-commitment-banner").remove();
			if (!adhdOn()) return;
			const commitment = extractCommitment(plainText(field.get_value?.() || ""));
			if (!commitment) return;
			const $node = $(`<div class="adhd-commitment-banner">
				<span class="adhd-flex">🤝 ${__("Commitment detected. Create a follow-up ToDo?")}</span>
				<button type="button" class="btn btn-xs btn-primary">${__("Create ToDo")}</button>
				<button type="button" class="btn btn-xs btn-default adhd-dismiss">${__("Dismiss")}</button>
			</div>`);
			field.$wrapper.after($node);
			$node.find(".btn-primary").on("click", async () => {
				if (frm.is_new())
					return frappe.msgprint(__("Save this document before creating its follow-up."));
				const todo = await frappe.db.insert({
					doctype: "ToDo",
					description: commitment.description,
					date: commitment.date,
					reference_type: frm.doctype,
					reference_name: frm.doc.name,
					assigned_by: frappe.session.user,
					owner: frappe.session.user,
				});
				frappe.show_alert({ message: __("ToDo {0} created.", [todo.name]), indicator: "green" });
				$node.remove();
			});
			$node.find(".adhd-dismiss").on("click", () => $node.remove());
		};
		field.$wrapper.off("input.adhdCommitment").on("input.adhdCommitment", () => {
			clearTimeout(dialog._adhdPromiseTimer);
			dialog._adhdPromiseTimer = setTimeout(render, 800);
		});
		render();
	}
	function renderCommitment(frm, row) {
		remove(frm, ".adhd-commitment-banner");
		if (!adhdOn()) return;
		// The note is a Text Editor field, so it holds HTML that must not end up in the ToDo description.
		const commitment = extractCommitment(plainText(row.note));
		if (!commitment) return;
		const $node = panel(
			frm,
			"adhd-commitment-banner",
			`<span class="adhd-flex">🤝 ${__("Commitment detected. Create a follow-up ToDo?")}</span>
			<button class="btn btn-xs btn-primary">${__("Create ToDo")}</button>
			<button class="btn btn-xs btn-default adhd-dismiss">${__("Dismiss")}</button>`
		);
		$node.find(".btn-primary").on("click", async () => {
			if (frm.is_new()) return frappe.msgprint(__("Save this document before creating its follow-up."));
			const todo = await frappe.db.insert({
				doctype: "ToDo",
				description: commitment.description,
				date: commitment.date,
				reference_type: frm.doctype,
				reference_name: frm.doc.name,
				assigned_by: frappe.session.user,
				owner: frappe.session.user,
			});
			frappe.show_alert({ message: __("ToDo {0} created.", [todo.name]), indicator: "green" });
			$node.remove();
		});
		$node.find(".adhd-dismiss").on("click", () => $node.remove());
	}
	frappe.ui.form.on("CRM Note", {
		note(frm, cdt, cdn) {
			clearTimeout(frm._adhdPromiseTimer);
			frm._adhdPromiseTimer = setTimeout(() => renderCommitment(frm, locals[cdt][cdn]), 800);
		},
	});

	// ADHD-049
	// A stage is clickable only when Opportunity already has a standard action for it: Proposal is
	// "Create > Quotation" (make_quotation) and Closed Lost is the "Set as Lost" dialog (declare_enquiry_lost, which
	// needs lost reasons and refuses while a Quotation is active). ERPNext sets the rest itself: Converted when a
	// Sales Order is submitted, Replied from the conversation, Open by "Reopen", so those stages are display-only.
	const OPPORTUNITY_STAGES = [
		{ label: __("Prospect"), status: "Open" },
		{ label: __("Qualified"), status: "Replied" },
		{ label: __("Proposal"), status: "Quotation", action: "quotation" },
		{ label: __("Closed Won"), status: "Converted", terminal: "won" },
		{ label: __("Closed Lost"), status: "Lost", terminal: "lost", action: "lost" },
	];
	function opportunityStageAction(frm, stage, state) {
		// the standard form offers neither before the first save, nor once the Opportunity is Lost
		if (!stage.action || frm.is_new?.() || frm.doc.status === "Lost") return null;
		if (stage.action === "lost") return frm.perm?.[0]?.write ? "lost" : null;
		// a quotation moves the Opportunity forward, so it is not offered from a later stage
		return state === "pending" ? "quotation" : null;
	}
	function runOpportunityStageAction(frm, action) {
		if (frm.is_new?.() || frm.doc.status === "Lost") return false;
		if (action === "lost") frm.trigger("set_as_lost_dialog");
		else if (action === "quotation") frm.trigger("create_quotation");
		else return false;
		return true;
	}
	function renderOpportunityPipeline(frm) {
		remove(frm, ".adhd-pipeline");
		if (!adhdOn()) return;
		const current = OPPORTUNITY_STAGES.findIndex((stage) => stage.status === frm.doc.status);
		const buttons = OPPORTUNITY_STAGES.map((stage, index) => {
			const state =
				index === current
					? stage.terminal || "current"
					: current >= 0 && index < current
					? "done"
					: "pending";
			const action = opportunityStageAction(frm, stage, state);
			const attributes = action
				? `data-action="${action}"`
				: `disabled aria-disabled="true"${
						index === current ? "" : ` title="${esc(__("RTB updates this stage itself."))}"`
				  }`;
			return `<button type="button" class="adhd-pipeline-stage adhd-pipeline-stage--${state}" data-status="${
				stage.status
			}" ${attributes}>${state === "done" ? "✓ " : ""}${esc(stage.label)}</button>`;
		}).join("<span>›</span>");
		const $node = panel(frm, "adhd-pipeline", buttons);
		$node.find("button[data-action]").on("click", function () {
			runOpportunityStageAction(frm, this.dataset.action);
		});
	}
	frappe.ui.form.on("Opportunity", {
		refresh: renderOpportunityPipeline,
		status: renderOpportunityPipeline,
	});
	erpnext.adhd.opportunityStageAction = opportunityStageAction;
	erpnext.adhd.runOpportunityStageAction = runOpportunityStageAction;

	// ADHD-050
	async function renderTaskBlockers(frm) {
		remove(frm, ".adhd-blocked-by");
		if (!adhdOn() || frm.is_new()) return;
		const names = [...new Set((frm.doc.depends_on || []).map((row) => row.task).filter(Boolean))];
		if (!names.length) return;
		const tasks = await frappe.db.get_list("Task", {
			filters: [
				["name", "in", names],
				["status", "not in", ["Completed", "Cancelled"]],
			],
			fields: ["name", "subject", "status"],
			limit: names.length,
		});
		if (!tasks.length) return;
		const links = tasks
			.map(
				(task) =>
					`<a target="_blank" rel="noopener" href="/app/task/${encodeURIComponent(
						task.name
					)}">${esc(task.subject || task.name)}</a>`
			)
			.join("");
		panel(
			frm,
			"adhd-blocked-by",
			`<strong>🚧 ${__("Blocked by {0} incomplete task(s)", [
				tasks.length,
			])}</strong><div>${links}</div>`
		);
	}
	frappe.ui.form.on("Task", { refresh: renderTaskBlockers, after_save: renderTaskBlockers });

	// ADHD-051 and ADHD-053
	function slaState(doc, now = Date.now()) {
		// A resolved, closed or fulfilled Issue has nothing left to count down to.
		if (["Resolved", "Closed"].includes(doc.status) || doc.agreement_status === "Fulfilled") return null;
		const target = !doc.first_responded_on && doc.response_by ? doc.response_by : doc.sla_resolution_by;
		if (!target) return null;
		const targetMs = datetimeMs(target);
		if (!Number.isFinite(targetMs)) return null;
		const creationMs = datetimeMs(doc.creation);
		const remaining = targetMs - now;
		const windowMs = Math.max(targetMs - creationMs, 1);
		return {
			target,
			remaining,
			tone: remaining < 0 ? "red" : remaining / windowMs <= 0.25 ? "amber" : "green",
		};
	}
	function formatSla(ms) {
		const absolute = Math.abs(ms);
		const hours = Math.floor(absolute / 3600000);
		const minutes = Math.floor((absolute % 3600000) / 60000);
		return ms < 0
			? __("BREACHED {0}h {1}m ago", [hours, minutes])
			: __("{0}h {1}m remaining", [hours, minutes]);
	}
	function renderIssueSla(frm) {
		remove(frm, "#adhd-sla-countdown");
		clearInterval(frm._adhdSlaInterval);
		if (!adhdOn()) return;
		const update = () => {
			const $existing = $(frm.wrapper).find("#adhd-sla-countdown");
			if (!adhdOn()) {
				clearInterval(frm._adhdSlaInterval);
				return $existing.remove();
			}
			const state = slaState(frm.doc);
			if (!state) return $existing.remove();
			const label = `SLA: ${formatSla(state.remaining)}`;
			if ($existing.length) {
				// .text() escapes on its own, so it takes the raw label.
				$existing.attr("class", `adhd-sla-badge adhd-sla-${state.tone}`).text(label);
			} else {
				prepend(
					frm,
					$(
						`<div id="adhd-sla-countdown" class="adhd-sla-badge adhd-sla-${state.tone}">${esc(
							label
						)}</div>`
					)
				);
			}
		};
		update();
		frm._adhdSlaInterval = setInterval(update, 60000);
	}

	// ADHD-053 needs no code here: the standard email composer already saves its draft (IndexedDB, per
	// document) as you type and restores it when the composer reopens. The composer is a body-level
	// dialog, so a form-level textarea autosave could never find it.
	frappe.ui.form.on("Issue", {
		refresh: renderIssueSla,
		before_load(frm) {
			clearInterval(frm._adhdSlaInterval);
		},
	});

	// ADHD-052
	function renderWarranty(frm) {
		remove(frm, "#adhd-warranty-banner");
		if (!adhdOn()) return;
		if (!frm.doc.complaint_date || !frm.doc.warranty_expiry_date) return;
		const difference = frappe.datetime.get_diff(frm.doc.complaint_date, frm.doc.warranty_expiry_date);
		const valid = difference <= 0;
		const text = valid
			? `✓ ${__("Warranty valid until {0}, COVERED", [
					frappe.datetime.str_to_user(frm.doc.warranty_expiry_date),
			  ])}`
			: `✗ ${__("Warranty expired {0} days before this complaint, NOT COVERED", [difference])}`;
		prepend(
			frm,
			$(
				`<div id="adhd-warranty-banner" class="adhd-warranty-${valid ? "valid" : "expired"}">${esc(
					text
				)}</div>`
			)
		);
	}
	frappe.ui.form.on("Warranty Claim", {
		refresh: renderWarranty,
		item_code: renderWarranty,
		warranty_expiry_date: renderWarranty,
		complaint_date: renderWarranty,
	});

	// ADHD-054
	async function renderAssetPrompt(frm) {
		remove(frm, "#adhd-asset-prompt");
		if (!adhdOn() || frm.doc.docstatus !== 1) return;
		const rows = (frm.doc.items || []).filter((row) => cint(row.is_fixed_asset));
		if (!rows.length) return;
		const existing = await getCount("Asset", { purchase_invoice: frm.doc.name, docstatus: ["!=", 2] });
		if (existing) return;
		const names = rows.map((row) => row.item_name || row.item_code).join(", ");
		// Refresh and after_save can overlap; whichever finishes last must not leave a second banner.
		remove(frm, "#adhd-asset-prompt");
		const $node = $(`<div id="adhd-asset-prompt" class="adhd-asset-banner">🏗️
			<span class="adhd-flex">${__("Create Asset records for {0}.", [esc(names)])}</span>
			<button class="btn btn-xs btn-primary">${__("Create Asset")}</button>
			<button class="btn btn-xs btn-default adhd-dismiss">${__("Dismiss")}</button></div>`);
		prepend(frm, $node);
		$node.find(".btn-primary").on("click", () => {
			const row = rows[0];
			frappe.route_options = {
				item_code: row.item_code,
				purchase_invoice: frm.doc.name,
				purchase_invoice_item: row.name,
				company: frm.doc.company,
			};
			frappe.new_doc("Asset");
			$node.remove();
		});
		$node.find(".adhd-dismiss").on("click", () => $node.remove());
	}
	frappe.ui.form.on("Purchase Invoice", { refresh: renderAssetPrompt, after_save: renderAssetPrompt });

	// ADHD-056
	const CAP_TABLES = {
		stock_items: __("Stock Items"),
		service_items: __("Service / Labor"),
		asset_items: __("Existing Assets"),
	};
	function renderCapitalizationWizard(frm) {
		remove(frm, "#adhd-cap-wizard");
		$(frm.wrapper).removeClass("adhd-cap-wizard-mode");
		$(frm.wrapper).find(".form-section").show();
		if (!adhdOn() || !frm.is_new()) return;
		frm._adhdCapStep ||= 1;
		const table = frm._adhdCapTable;
		const rows = table ? frm.doc[table] || [] : [];
		const summary = table
			? `<p><strong>${__("Target Asset")}:</strong> ${esc(frm.doc.target_asset || "—")}</p>
				<p><strong>${__("Items")}:</strong> ${rows.length}</p>
				<p><strong>${__("Total value")}:</strong> ${format_currency(flt(frm.doc.total_value), frm.doc.currency)}</p>`
			: "";
		const choices = Object.entries(CAP_TABLES)
			.map(
				([field, label]) =>
					`<button type="button" class="adhd-cap-choice ${
						table === field ? "selected" : ""
					}" data-table="${field}">${esc(label)}</button>`
			)
			.join("");
		const content =
			frm._adhdCapStep === 1
				? choices
				: frm._adhdCapStep === 2
				? `<p>${__("Use the standard table below to add {0}, then select a Target Asset.", [
						CAP_TABLES[table],
				  ])}</p>`
				: summary;
		const $wizard = $(`<div id="adhd-cap-wizard">
			<div class="adhd-step-bar">${[1, 2, 3]
				.map((step) => `<span class="${step === frm._adhdCapStep ? "active" : ""}">${step}</span>`)
				.join("")}</div>
			<div class="adhd-step-content">${content}</div>
			<div class="adhd-wizard-footer">
				<button class="btn btn-default adhd-back" ${frm._adhdCapStep === 1 ? "disabled" : ""}>${__("Back")}</button>
				<button class="btn btn-primary adhd-next">${frm._adhdCapStep === 3 ? __("Save Draft") : __("Next")}</button>
				${frm._adhdCapStep === 3 ? `<button class="btn btn-primary adhd-submit">${__("Submit")}</button>` : ""}
				<button class="btn btn-default adhd-full">${__("Show full form")}</button>
			</div></div>`);
		$(frm.wrapper).addClass("adhd-cap-wizard-mode");
		$(frm.wrapper).find(".form-layout").before($wizard);
		$(frm.wrapper).find(".form-section").hide();
		if (frm._adhdCapStep === 2 && table) {
			frm.fields_dict.company?.$wrapper.closest(".form-section").show();
			frm.fields_dict.target_asset?.$wrapper.closest(".form-section").show();
			frm.fields_dict[table]?.$wrapper.closest(".form-section").show();
		}
		$wizard.find(".adhd-cap-choice").on("click", function () {
			frm._adhdCapTable = this.dataset.table;
			renderCapitalizationWizard(frm);
		});
		$wizard.find(".adhd-back").on("click", () => {
			frm._adhdCapStep -= 1;
			renderCapitalizationWizard(frm);
		});
		$wizard.find(".adhd-next").on("click", async () => {
			if (frm._adhdCapStep === 1 && !frm._adhdCapTable)
				return frappe.msgprint(__("Select a capitalization source."));
			if (frm._adhdCapStep === 2) {
				if (!frm.doc.target_asset) return frappe.msgprint(__("Select a Target Asset."));
				if (!(frm.doc[frm._adhdCapTable] || []).length)
					return frappe.msgprint(__("Add at least one item."));
			}
			if (frm._adhdCapStep === 3) return frm.save();
			frm._adhdCapStep += 1;
			renderCapitalizationWizard(frm);
		});
		$wizard.find(".adhd-full").on("click", () => {
			$(frm.wrapper).removeClass("adhd-cap-wizard-mode");
			$wizard.hide();
			$(frm.wrapper).find(".form-section").show();
		});
		$wizard.find(".adhd-submit").on("click", () => frm.savesubmit());
	}
	frappe.ui.form.on("Asset Capitalization", { refresh: renderCapitalizationWizard });
	// The wizard hides every form section, so it has to go the moment the mode is switched off.
	erpnext.adhd.onStateChange?.(() => {
		const frm = window.cur_frm;
		if (frm?.doctype === "Asset Capitalization" && frm.doc) renderCapitalizationWizard(frm);
	});

	// ADHD-060
	async function renderQualityBanner(frm) {
		remove(frm, "#adhd-qi-banner");
		if (!adhdOn()) return;
		const names = [
			...new Set((frm.doc.items || []).map((row) => row.quality_inspection).filter(Boolean)),
		];
		if (!names.length) return;
		const response = await frappe.call({
			method: "erpnext.stock.adhd_quality.get_quality_inspection_summaries",
			args: { names },
		});
		const inspections = response.message || [];
		const rejected = inspections.filter((row) => row.status === "Rejected");
		const rejectedReadings = inspections.reduce((sum, row) => sum + cint(row.rejected_readings), 0);
		const pending =
			inspections.length < names.length ||
			inspections.some(
				(row) => cint(row.docstatus) === 0 || !["Accepted", "Rejected"].includes(row.status)
			);
		const state = rejected.length ? "fail" : pending ? "pending" : "pass";
		const text =
			state === "fail"
				? `✗ ${__("QI: FAILED, {0} reading(s) out of spec", [rejectedReadings])}`
				: state === "pending"
				? `⏳ ${__("QI: Pending inspection")}`
				: `✓ ${__("QI: PASSED")}`;
		remove(frm, "#adhd-qi-banner");
		prepend(frm, $(`<div id="adhd-qi-banner" class="adhd-qi-${state}">${esc(text)}</div>`));
	}
	for (const doctype of ["Purchase Receipt", "Delivery Note", "Stock Entry"]) {
		frappe.ui.form.on(doctype, { refresh: renderQualityBanner });
	}

	// ADHD-061. The current schema has per_received, while sent progress is derived from supplied items.
	function subcontractingState(doc, receiptCount = 0) {
		const required = (doc.supplied_items || []).reduce((sum, row) => sum + flt(row.required_qty), 0);
		const supplied = (doc.supplied_items || []).reduce(
			(sum, row) => sum + flt(row.total_supplied_qty ?? row.supplied_qty),
			0
		);
		const sentPercent = required ? (supplied / required) * 100 : 0;
		if (["Closed", "Completed"].includes(doc.status) || flt(doc.per_received) >= 100) {
			return { index: 4, sentPercent };
		}
		if (receiptCount) return { index: 3, sentPercent };
		if (sentPercent >= 100) return { index: 2, sentPercent };
		if (sentPercent > 0) return { index: 1, sentPercent };
		return { index: 0, sentPercent };
	}
	async function renderSubcontractingChain(frm) {
		remove(frm, "#adhd-subcon-chain");
		if (!adhdOn() || frm.doc.docstatus !== 1) return;
		// subcontracting_order lives on the Subcontracting Receipt Item child table, not on the receipt itself.
		const receiptCount = await getCount("Subcontracting Receipt", [
			["Subcontracting Receipt Item", "subcontracting_order", "=", frm.doc.name],
			["docstatus", "!=", 2],
		]);
		const state = subcontractingState(frm.doc, receiptCount);
		const labels = [
			__("Order Created"),
			__("Materials Sent"),
			__("Work in Progress"),
			__("Receipt Pending"),
			__("Closed"),
		];
		const steps = labels
			.map(
				(label, index) =>
					`<span class="${
						index < state.index ? "done" : index === state.index ? "active" : "upcoming"
					}">${esc(label)}</span>`
			)
			.join("<i>›</i>");
		const $node = $(
			`<div id="adhd-subcon-chain" class="adhd-subcon-chain"><div>${steps}</div><div class="adhd-action"></div></div>`
		);
		remove(frm, "#adhd-subcon-chain");
		prepend(frm, $node);
		const $action = $node.find(".adhd-action");
		if (state.index === 4) return $action.text(`✓ ${__("Complete")}`);
		const receipt = state.sentPercent >= 100;
		const label = receipt
			? __("Create Receipt")
			: state.sentPercent
			? __("Send Remaining Materials")
			: __("Send Materials");
		$action.append(`<button type="button" class="btn btn-primary btn-xs">${esc(label)}</button>`);
		$action.find("button").on("click", () => {
			if (receipt) {
				frappe.model.open_mapped_doc({
					method: "erpnext.subcontracting.doctype.subcontracting_order.subcontracting_order.make_subcontracting_receipt",
					frm,
				});
			} else {
				frappe.call({
					method: "erpnext.controllers.subcontracting_controller.make_rm_stock_entry",
					args: { subcontract_order: frm.doc.name, order_doctype: frm.doc.doctype },
					callback: (response) => {
						const docs = frappe.model.sync(response.message);
						if (docs?.[0]) frappe.set_route("Form", docs[0].doctype, docs[0].name);
					},
				});
			}
		});
	}
	frappe.ui.form.on("Subcontracting Order", { refresh: renderSubcontractingChain });

	erpnext.adhd.datetimeMs = datetimeMs;
	erpnext.adhd.systemDatetimeAt = systemDatetimeAt;
	erpnext.adhd.productionPlanSummary = productionPlanSummary;
	erpnext.adhd.elapsedParts = elapsedParts;
	erpnext.adhd.isBlockedJobCard = isBlockedJobCard;
	erpnext.adhd.deadlineState = deadlineState;
	erpnext.adhd.attachCommitmentDetector = attachCommitmentDetector;
	erpnext.adhd.extractCommitment = extractCommitment;
	erpnext.adhd.resolvePromiseDate = resolvePromiseDate;
	erpnext.adhd.slaState = slaState;
	erpnext.adhd.subcontractingState = subcontractingState;
})();
