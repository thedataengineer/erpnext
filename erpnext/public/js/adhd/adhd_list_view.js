// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors

frappe.provide("erpnext.adhd");

(() => {
	const DATE_FIELD_MAP = {
		"Sales Order": "delivery_date",
		"Purchase Order": "schedule_date",
		Task: "exp_end_date",
		"Sales Invoice": "due_date",
		"Leave Application": "to_date",
		Issue: "sla_resolution_by",
		Asset: "next_depreciation_date",
		Quotation: "valid_till",
		// how long ago it was last saved, not a due date (see getStalenessHeat)
		Opportunity: "modified",
	};
	// Once a quotation is ordered, lost or expired, or an opportunity is converted or lost, its date is no longer a
	// deadline, so those rows get no heat.
	const CLOSED_STATUSES = {
		Quotation: ["Ordered", "Lost", "Expired"],
		Opportunity: ["Converted", "Lost"],
	};
	// A quotation can still be accepted on its valid_till date (the server marks it Expired only once that date is
	// before today), so its last day is red along with the days after it, and the week before is amber.
	const EXPIRY_AMBER_DAYS = 7;
	// An opportunity nobody has saved for more than a week is amber, and for more than two weeks red. The form
	// badge in adhd_opportunity.js uses the same red line.
	const STALE_AMBER_DAYS = 7;
	const STALE_RED_DAYS = 14;
	// Doctypes whose rows also get a tooltip saying why they are marked
	const TITLED_DOCTYPES = ["Asset", "Quotation", "Opportunity"];
	const HEAT_CLASSES = "adhd-heat--overdue adhd-heat--soon adhd-heat--upcoming";
	const STOCK_CLASSES = "adhd-stock-critical adhd-stock-low adhd-stock-unknown";
	let observer = null;
	let stockObserver = null;
	let heatInterval = null;
	let defaultWarehousePromise = null;

	// The heat map is the "Due-Date Heat Maps" switch in ADHD Settings. Without that module it stays as it was.
	// Only the heat map: the Item stock health below is not part of this switch.
	function isHeatMapOn() {
		const settings = erpnext.adhd.ADHDSettings || window.ADHDSettings;
		return !settings || Boolean(settings.get("due_date_heatmap"));
	}

	function getUrgencyClass(dateValue) {
		if (!dateValue) return null;
		const diff = frappe.datetime.get_diff(dateValue, frappe.datetime.get_today());
		if (diff < 0) return "adhd-heat--overdue";
		if (diff <= 2) return "adhd-heat--soon";
		if (diff <= 7) return "adhd-heat--upcoming";
		return null;
	}

	function isClosed(row, doctype) {
		return (
			cint(row.docstatus) === 2 ||
			["Closed", "Completed", "Cancelled", "Paid"].includes(row.status) ||
			(CLOSED_STATUSES[doctype] || []).includes(row.status)
		);
	}

	function getIssueUrgency(row, now = Date.now()) {
		const target = !row.first_responded_on && row.response_by ? row.response_by : row.sla_resolution_by;
		if (!target) return null;
		const targetMs = new Date(String(target).replace(" ", "T")).getTime();
		const creationMs = new Date(String(row.creation).replace(" ", "T")).getTime();
		const windowMs = Math.max(targetMs - creationMs, 1);
		const remaining = targetMs - now;
		if (remaining < 0) return "adhd-heat--overdue";
		if (remaining / windowMs <= 0.25) return "adhd-heat--soon";
		return "adhd-heat--upcoming";
	}

	function getAssetUrgency(row, today = frappe.datetime.get_today()) {
		if (!row.next_depreciation_date) return null;
		const days = frappe.datetime.get_diff(row.next_depreciation_date, today);
		if (days < 0) return "adhd-heat--overdue";
		if (days <= 7) return "adhd-heat--soon";
		if (days <= 30) return "adhd-heat--upcoming";
		return null;
	}

	function describeQuotationExpiry(days) {
		if (days < -1) return __("Expired {0} days ago", [-days]);
		if (days === -1) return __("Expired yesterday");
		if (days === 0) return __("Expires today");
		if (days === 1) return __("Expires tomorrow");
		return __("Expires in {0} days", [days]);
	}

	function getQuotationHeat(row, today = frappe.datetime.get_today()) {
		if (!row.valid_till) return null;
		const days = frappe.datetime.get_diff(row.valid_till, today);
		if (!Number.isFinite(days) || days > EXPIRY_AMBER_DAYS) return null;
		return {
			heatClass: days <= 0 ? "adhd-heat--overdue" : "adhd-heat--soon",
			title: describeQuotationExpiry(days),
		};
	}

	// `modified` is a server datetime in the system time zone, while get_today() is the user's date: move it into
	// the user's zone first, so a save late in the evening is not counted a day early or late.
	function getDaysSinceModified(modified, today = frappe.datetime.get_today()) {
		if (!modified) return null;
		const modifiedDay = frappe.datetime.convert_to_user_tz(modified, false).format("YYYY-MM-DD");
		const days = frappe.datetime.get_diff(today, modifiedDay);
		return Number.isFinite(days) ? days : null;
	}

	function getStalenessHeat(row, today = frappe.datetime.get_today()) {
		const days = getDaysSinceModified(row.modified, today);
		if (days === null || days <= STALE_AMBER_DAYS) return null;
		return {
			heatClass: days > STALE_RED_DAYS ? "adhd-heat--overdue" : "adhd-heat--soon",
			title: __("No activity for {0} days.", [days]),
		};
	}

	const HEAT_BY_DOCTYPE = { Quotation: getQuotationHeat, Opportunity: getStalenessHeat };

	// List views keep their fetch set as [fieldname, doctype] pairs
	function hasListField(listview, fieldname) {
		return (listview.fields || []).some((field) =>
			Array.isArray(field) ? field[0] === fieldname : (field.fieldname || field) === fieldname
		);
	}

	function ensureListField(listview, fieldname) {
		if (hasListField(listview, fieldname)) return false;
		if (typeof listview._add_field === "function") {
			// validates the field against the doctype meta before adding it
			listview._add_field(fieldname);
		} else {
			listview.fields.push([fieldname, listview.doctype]);
		}
		return hasListField(listview, fieldname);
	}

	// frappe.views.list_view is a map keyed by route; the list on screen is cur_list
	function resolveCurrentList(route, curList) {
		if (!route || route[0] !== "List" || !curList || curList.doctype !== route[1]) return null;
		return curList;
	}

	async function getCurrentListView() {
		const listview = resolveCurrentList(frappe.get_route(), window.cur_list);
		if (!listview) return null;
		// fields and $result only exist once the list view has initialised
		for (let attempt = 0; attempt < 50 && !listview.init_promise; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await Promise.resolve(listview.init_promise).catch(() => null);
		// the user may have navigated away while it was loading
		return window.cur_list === listview && listview.view === "List" ? listview : null;
	}

	// data-name is on the checkbox and the subject link inside a row, not on the row itself, and the heat CSS
	// styles .list-row: the mark goes on the row that holds the element with that name.
	function findRow(listview, name) {
		const $match = listview.$result
			.find("[data-name]")
			.filter((_, element) => element.getAttribute("data-name") === name)
			.first();
		const $row = $match.closest?.(".list-row");
		return $row && $row.length ? $row : $match;
	}

	// Takes off everything applyHeat put on the rows.
	function clearHeat(listview) {
		const $rows =
			listview && listview._adhdHeatOn && listview.$result && listview.$result.find(".list-row");
		if (!$rows) return;
		listview._adhdHeatOn = false;
		$rows.removeClass(HEAT_CLASSES);
		// the tooltips are the only attribute the heat map sets, and only on these doctypes' rows
		if (TITLED_DOCTYPES.includes(listview.doctype)) $rows.removeAttr("title");
	}

	function applyHeat(listview) {
		if (!(frappe.boot && frappe.boot.adhd_mode) || !isHeatMapOn() || !listview) return;
		const dateField = DATE_FIELD_MAP[listview.doctype];
		if (!dateField || !listview.$result) return;
		listview._adhdHeatOn = true;
		(listview.data || []).forEach((row) => {
			const $row = findRow(listview, row.name);
			$row.removeClass(HEAT_CLASSES);
			const getHeat = HEAT_BY_DOCTYPE[listview.doctype];
			if (getHeat) $row.removeAttr("title");
			if ($row.length && !isClosed(row, listview.doctype)) {
				const heat = getHeat ? getHeat(row) : null;
				const heatClass = getHeat
					? heat?.heatClass
					: listview.doctype === "Issue"
					? getIssueUrgency(row)
					: listview.doctype === "Asset"
					? getAssetUrgency(row)
					: getUrgencyClass(row[dateField]);
				if (heatClass) $row.addClass(heatClass);
				if (heat) $row.attr("title", heat.title);
				if (listview.doctype === "Asset" && row.next_depreciation_date) {
					$row.attr(
						"title",
						__("Next depreciation: {0}", [
							frappe.datetime.str_to_user(row.next_depreciation_date),
						])
					);
				}
			}
		});
	}

	function attachHeatMap(listview) {
		if (observer) observer.disconnect();
		observer = null;
		if (!DATE_FIELD_MAP[listview && listview.doctype]) return;
		// switched off, in ADHD Settings or with ADHD mode itself: nothing watches the list, no field is added to
		// it, and its rows lose their heat
		if (!(frappe.boot && frappe.boot.adhd_mode) || !isHeatMapOn()) {
			clearInterval(heatInterval);
			heatInterval = null;
			clearHeat(listview);
			return;
		}

		const dateField = DATE_FIELD_MAP[listview.doctype];
		listview.fields ||= [];
		const fields =
			listview.doctype === "Issue"
				? ["response_by", "sla_resolution_by", "first_responded_on", "creation"]
				: [dateField];
		let fieldsAdded = false;
		for (const fieldname of fields) {
			if (ensureListField(listview, fieldname)) fieldsAdded = true;
		}

		const wrapper = listview.$result && listview.$result[0];
		if (!wrapper) return;
		observer = new MutationObserver(() => applyHeat(listview));
		observer.observe(wrapper, { childList: true, subtree: true });
		applyHeat(listview);
		clearInterval(heatInterval);
		heatInterval = setInterval(() => applyHeat(listview), 60000);
		if (fieldsAdded && !listview._adhdHeatFieldsLoaded) {
			listview._adhdHeatFieldsLoaded = true;
			listview.refresh();
		}
	}

	function getDefaultWarehouse() {
		if (!defaultWarehousePromise) {
			defaultWarehousePromise = (async () => {
				const userDefault = frappe.defaults.get_user_default("Warehouse");
				if (userDefault) return userDefault;
				const company = frappe.boot.sysdefaults.company;
				const companyDefault = company
					? await frappe.db
							.get_value("Company", company, "default_warehouse")
							.then((result) => result.message?.default_warehouse)
					: null;
				if (companyDefault) return companyDefault;
				const warehouses = await frappe.db.get_list("Warehouse", {
					filters: [
						["company", "=", company],
						["is_group", "=", 0],
						["disabled", "=", 0],
					],
					fields: ["name"],
					limit: 1,
				});
				return warehouses[0]?.name || null;
			})();
		}
		return defaultWarehousePromise;
	}

	function classifyStockHealth(actualQty, reorderLevel) {
		if (
			actualQty === null ||
			actualQty === undefined ||
			reorderLevel === null ||
			reorderLevel === undefined
		) {
			return "adhd-stock-unknown";
		}
		if (actualQty <= reorderLevel) return "adhd-stock-critical";
		if (actualQty <= reorderLevel * 1.25) return "adhd-stock-low";
		return null;
	}

	function applyStockHealthClass($row, actualQty, reorderLevel, warehouse) {
		const healthClass = classifyStockHealth(actualQty, reorderLevel);
		$row.removeClass(STOCK_CLASSES).removeAttr("title");
		const $subject = $row.find(".list-subject").first();
		if (!healthClass || healthClass === "adhd-stock-unknown") {
			$subject.find(".adhd-stock-dot").remove();
			if (healthClass) $row.addClass(healthClass);
			return;
		}
		$row.addClass(healthClass).attr(
			"title",
			`Stock: ${actualQty} units | Reorder at: ${reorderLevel} | Warehouse: ${warehouse}`
		);
		if (!$subject.find(".adhd-stock-dot").length) {
			$subject.prepend('<span class="adhd-stock-dot" aria-hidden="true"></span>');
		}
	}

	async function applyItemStockHealth(listview) {
		if (!(frappe.boot && frappe.boot.adhd_mode) || listview?.doctype !== "Item") return;
		const warehouse = await getDefaultWarehouse();
		if (!warehouse || !listview.$result) return;
		const $rows = listview.$result.find(".list-row[data-name]");
		if ($rows.length > 200) {
			if (!listview._adhdStockLimitNoticeShown) {
				frappe.show_alert({
					message: __("Focus stock health: showing is limited to 200 visible items."),
					indicator: "blue",
				});
				listview._adhdStockLimitNoticeShown = true;
			}
			return;
		}
		const itemNames = [
			...new Set(
				$rows
					.map((_, row) => row.dataset.name)
					.get()
					.filter(Boolean)
			),
		];
		if (!itemNames.length) return;
		const requestId = (listview._adhdStockRequest || 0) + 1;
		listview._adhdStockRequest = requestId;
		const response = await frappe.call({
			method: "erpnext.stock.adhd.get_item_stock_health",
			args: { item_codes: itemNames, warehouse },
		});
		if (requestId !== listview._adhdStockRequest) return;
		const health = new Map((response.message || []).map((row) => [row.item_code, row]));
		$rows.each((_, element) => {
			const row = health.get(element.dataset.name) || {};
			applyStockHealthClass($(element), row.actual_qty, row.reorder_level, warehouse);
		});
	}

	function attachItemStockHealth(listview) {
		if (stockObserver) stockObserver.disconnect();
		stockObserver = null;
		if (listview?.doctype !== "Item") return;
		if (!(frappe.boot && frappe.boot.adhd_mode)) {
			listview.$result
				?.find(".list-row[data-name]")
				.removeClass(STOCK_CLASSES)
				.removeAttr("title")
				.find(".adhd-stock-dot")
				.remove();
			return;
		}
		const wrapper = listview.$result?.[0];
		if (!wrapper) return;
		const refresh = frappe.utils.debounce(() => applyItemStockHealth(listview).catch(() => null), 300);
		stockObserver = new MutationObserver(refresh);
		stockObserver.observe(wrapper, { childList: true, subtree: true });
		applyItemStockHealth(listview).catch(() => null);
	}

	frappe.router.on("change", () => {
		if (observer) observer.disconnect();
		observer = null;
		clearInterval(heatInterval);
		heatInterval = null;
		if (stockObserver) stockObserver.disconnect();
		stockObserver = null;
		frappe.after_ajax(async () => {
			const listview = await getCurrentListView();
			if (listview) {
				attachHeatMap(listview);
				attachItemStockHealth(listview);
			}
		});
	});

	// Switching the heat map on or off in ADHD Settings takes effect on the list on screen at once. `detail` is
	// { key, value } for one switch and undefined for a reset, which can change all of them.
	if (typeof $ === "function") {
		$(document).on?.("adhd_setting_changed adhd_settings_reset", async (_event, detail) => {
			if (detail && detail.key !== "due_date_heatmap") return;
			const listview = await getCurrentListView();
			if (listview) attachHeatMap(listview);
		});
	}

	// Switching ADHD mode itself on or off (the toggle, Alt+A) changes the list on screen at once too. onStateChange
	// calls this once as it registers, when there is usually no list yet.
	erpnext.adhd.onStateChange?.(async () => {
		const listview = await getCurrentListView().catch(() => null);
		if (listview) attachHeatMap(listview);
	});

	// Another app (Hubble, the HR app) says which date field makes a row urgent, and which statuses mean it is over.
	function registerListDate(doctype, dateField, closedStatuses) {
		if (!doctype || typeof dateField !== "string" || !dateField) return false;
		DATE_FIELD_MAP[doctype] = dateField;
		if (Array.isArray(closedStatuses)) CLOSED_STATUSES[doctype] = closedStatuses;
		return true;
	}
	erpnext.adhd.registerListDate = registerListDate;
	erpnext.adhd.DATE_FIELD_MAP = DATE_FIELD_MAP;
	erpnext.adhd.hasListField = hasListField;
	erpnext.adhd.ensureListField = ensureListField;
	erpnext.adhd.resolveCurrentList = resolveCurrentList;
	erpnext.adhd.getUrgencyClass = getUrgencyClass;
	erpnext.adhd.applyHeat = applyHeat;
	erpnext.adhd.classifyStockHealth = classifyStockHealth;
	erpnext.adhd.applyItemStockHealth = applyItemStockHealth;
	erpnext.adhd.getIssueUrgency = getIssueUrgency;
	erpnext.adhd.getAssetUrgency = getAssetUrgency;
	erpnext.adhd.getQuotationHeat = getQuotationHeat;
	erpnext.adhd.getStalenessHeat = getStalenessHeat;
	erpnext.adhd.getDaysSinceModified = getDaysSinceModified;
	erpnext.adhd.STALE_RED_DAYS = STALE_RED_DAYS;
})();

if (!$("#adhd-stock-health-styles").length) {
	$("<style>", {
		id: "adhd-stock-health-styles",
		text: `.adhd-stock-critical{border-left:4px solid var(--red-500)!important}
			.adhd-stock-low{border-left:4px solid var(--yellow-500)!important}
			.adhd-stock-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
			.adhd-stock-critical .adhd-stock-dot{background:var(--red-500)}
			.adhd-stock-low .adhd-stock-dot{background:var(--yellow-500)}`,
	}).appendTo("head");
}
