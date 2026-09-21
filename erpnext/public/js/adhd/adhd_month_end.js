// Month-end checklist with per-user, per-month local persistence.

frappe.provide("erpnext.adhd");

erpnext.adhd.MONTH_END_STEPS = [
	{
		id: "bank_recon",
		label: __("Bank Reconciliation"),
		description: __("Match bank transactions to ledger entries for the closing month."),
		link: "/app/bank-reconciliation-tool",
		estimatedMinutes: 30,
	},
	{
		id: "debtors_aging",
		label: __("Debtors Aging"),
		description: __("Review unpaid customer balances and overdue invoices."),
		link: "/app/accounts-receivable",
		estimatedMinutes: 15,
	},
	{
		id: "provisions",
		label: __("Provisions"),
		description: __("Record known expenses that have not been invoiced."),
		link: "/app/journal-entry/new-journal-entry-1?voucher_type=Accrual",
		estimatedMinutes: 20,
	},
	{
		id: "period_close",
		label: __("Period Close"),
		description: __("Close the accounting period after completing all checks."),
		link: "/app/period-closing-voucher",
		estimatedMinutes: 10,
		auto: true,
	},
	{
		id: "pl_review",
		label: __("Profit and Loss Review"),
		description: __("Review revenue, costs, and unusual month-end movements."),
		link: "/app/profit-and-loss-statement",
		estimatedMinutes: 15,
	},
];

function monthContext() {
	const date = new Date();
	const month = `${date.getFullYear()}_${String(date.getMonth() + 1).padStart(2, "0")}`;
	const apiMonth = month.replace("_", "-");
	const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
	return {
		month,
		apiMonth,
		fromDate: `${apiMonth}-01`,
		toDate: `${apiMonth}-${String(lastDay).padStart(2, "0")}`,
		label: date.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
		key: `adhd_me_${frappe.session.user}_${month}`,
	};
}

function loadMonthEndState(key) {
	try {
		return JSON.parse(localStorage.getItem(key)) || {};
	} catch {
		return {};
	}
}

function renderReadinessResults($body, data) {
	const summaryClass = data.ready ? "text-success" : "text-danger";
	const summaryIcon = data.ready ? "✅" : "⚠";
	const issues = (data.issues || [])
		.map(
			(issue) => `
				<li class="adhd-readiness-issue adhd-readiness-${issue.severity}" data-type="${frappe.utils.escape_html(
					issue.type,
				)}">
					<span class="adhd-readiness-label">${frappe.utils.escape_html(issue.label)}</span>
					<a href="${frappe.utils.escape_html(issue.link)}">${__("View ›")}</a>
					<button type="button" class="btn btn-xs btn-default adhd-recheck-btn"
						data-type="${frappe.utils.escape_html(issue.type)}">${__("Recheck")}</button>
				</li>`,
		)
		.join("");
	$body.html(`
		<div class="adhd-readiness-summary ${summaryClass}">${summaryIcon} ${frappe.utils.escape_html(
			data.summary,
		)}</div>
		${issues ? `<ul class="adhd-readiness-list">${issues}</ul>` : ""}
	`);
}

async function runReadinessCheck(company, fromDate, toDate, issueType = null) {
	const $section = $("#adhd-close-readiness");
	const $body = $section.find(".adhd-readiness-body");
	if (!$body.length) return;
	if (!issueType) $body.html(`<span class="text-muted">${__("Checking…")}</span>`);
	try {
		const response = await frappe.call({
			method: "erpnext.accounts.services.adhd_period_close_check.get_period_close_readiness",
			args: { company, from_date: fromDate, to_date: toDate },
		});
		if (!response.message) return;
		if (!issueType) {
			renderReadinessResults($body, response.message);
			return;
		}

		const issue = (response.message.issues || []).find((item) => item.type === issueType);
		const $row = $body
			.find(".adhd-readiness-issue")
			.filter((_, element) => element.dataset.type === issueType);
		if (issue && $row.length) {
			$row.find(".adhd-readiness-label").text(issue.label);
			$row.find("a").attr("href", issue.link);
		} else {
			$row.remove();
		}
		const $summary = $body.find(".adhd-readiness-summary");
		$summary
			.toggleClass("text-success", response.message.ready)
			.toggleClass("text-danger", !response.message.ready)
			.text(`${response.message.ready ? "✅" : "⚠"} ${response.message.summary}`);
	} catch {
		$body.html(`<span class="text-danger">${__("Readiness check failed. Try again.")}</span>`);
	}
}

function renderReadinessSection($container, context) {
	const company = frappe.boot.sysdefaults.company;
	if (!company) return;
	const $section = $(`
		<div id="adhd-close-readiness" class="adhd-readiness-section">
			<div class="adhd-readiness-header">
				<h5>${__("Close Readiness")}</h5>
				<button type="button" class="btn btn-sm btn-default adhd-check-readiness-btn">${__(
					"Check Now",
				)}</button>
			</div>
			<div class="adhd-readiness-body">
				<span class="text-muted">${__('Click "Check Now" to scan for blocking issues.')}</span>
			</div>
		</div>
	`);
	$container.find(".adhd-month-end-checklist").append($section);
	const check = (issueType = null) =>
		runReadinessCheck(company, context.fromDate, context.toDate, issueType);
	$section.find(".adhd-check-readiness-btn").on("click", () => check());
	$section.on("click", ".adhd-recheck-btn", (event) => check(event.currentTarget.dataset.type));
	$section.data("adhd-readiness-check", check);
}

async function initMonthEndChecklist(container) {
	const $container = $(container);
	if (!erpnext.adhd?.isActive?.()) {
		$container.html(`<div class="text-muted">${__("ADHD mode is off.")}</div>`);
		return;
	}

	const context = monthContext();
	const state = loadMonthEndState(context.key);
	const save = () => localStorage.setItem(context.key, JSON.stringify(state));

	const render = () => {
		const complete = erpnext.adhd.MONTH_END_STEPS.filter((step) => state[step.id]).length;
		const rows = erpnext.adhd.MONTH_END_STEPS.map(
			(step) => `
				<div class="adhd-month-end-step ${state[step.id] ? "is-complete" : ""}">
					${
						step.auto
							? `<span class="adhd-auto-check">${state[step.id] ? __("✓ auto-detected") : __("Checking…")}</span>`
							: `<input type="checkbox" id="adhd-me-${step.id}" data-step="${step.id}" ${
									state[step.id] ? "checked" : ""
								}>`
					}
					<label for="adhd-me-${step.id}">${step.label}</label>
					<small>${step.description}</small>
					<span class="adhd-time-badge">~${step.estimatedMinutes} ${__("min")}</span>
					<a class="btn btn-xs btn-default" href="${step.link}">${__("Open →")}</a>
				</div>`,
		).join("");
		$container.html(`
			<div class="adhd-month-end-checklist">
				<h4>${__("Month-End Close — {0}", [context.label])}</h4>
				<label>${__("{0} of 5 steps complete", [complete])}</label>
				<progress max="5" value="${complete}"></progress>
				${rows}
				<button type="button" class="btn btn-default btn-sm adhd-month-reset">${__("Start New Month")}</button>
			</div>
		`);
		renderReadinessSection($container, context);
		$container.find("input[data-step]").on("change", (event) => {
			state[event.currentTarget.dataset.step] = event.currentTarget.checked;
			save();
			render();
		});
		$container.find(".adhd-month-reset").on("click", () => {
			frappe.confirm(__("Clear this month's checklist?"), () => {
				localStorage.removeItem(context.key);
				initMonthEndChecklist(container);
			});
		});
	};

	render();
	try {
		const response = await frappe.call({
			method: "erpnext.accounts.services.adhd_month_end.is_period_closed",
			args: { month_str: context.apiMonth, company: frappe.boot.sysdefaults.company },
		});
		if (response.message) {
			state.period_close = true;
			save();
		}
	} finally {
		render();
	}
}

erpnext.adhd.initMonthEndChecklist = initMonthEndChecklist;
erpnext.adhd.runReadinessCheck = runReadinessCheck;

$(document)
	.off("visibilitychange.adhdReadiness")
	.on("visibilitychange.adhdReadiness", () => {
		if (document.visibilityState !== "visible") return;
		$("#adhd-close-readiness").data("adhd-readiness-check")?.();
	});
