// Route summary and stop sequence badges for Delivery Trip.

frappe.provide("erpnext.adhd");

(() => {
	async function computeRouteSummary(frm) {
		const stops = frm.doc.delivery_stops || [];
		if (!stops.length) return null;
		const deliveryNotes = [...new Set(stops.map((stop) => stop.delivery_note).filter(Boolean))];
		let totalPackages = 0;
		if (deliveryNotes.length) {
			const response = await frappe.call({
				method: "erpnext.stock.adhd.get_delivery_note_package_qty",
				args: { delivery_notes: deliveryNotes },
			});
			totalPackages = Number(response.message) || 0;
		}
		return {
			totalStops: stops.length,
			totalPackages,
			firstAddress: stops[0]?.customer_address || stops[0]?.address || "—",
			totalDistance: frm.doc.total_distance
				? `${frm.doc.total_distance} ${frm.doc.uom || "km"}`
				: "—",
		};
	}

	function applySequenceBadges(frm) {
		const $grid = $(frm.fields_dict.delivery_stops?.grid?.wrapper);
		$grid.find(".adhd-stop-badge").remove();
		$grid.find(".grid-row[data-name]").each((index, element) => {
			const $row = $(element);
			const $target = $row.find(".row-check").first().length
				? $row.find(".row-check").first()
				: $row.find(".col").first();
			$target.prepend(
				`<span class="adhd-stop-badge" aria-label="${__("Stop {0}", [index + 1])}">${
					index + 1
				}</span>`,
			);
		});
	}

	function watchGridForBadgeUpdates(frm) {
		const target = $(frm.fields_dict.delivery_stops?.grid?.wrapper)[0];
		if (!target || frm._adhdRouteObserver) return;
		frm._adhdRouteObserver = new MutationObserver((mutations) => {
			const rowsChanged = mutations.some((mutation) =>
				[...mutation.addedNodes, ...mutation.removedNodes].some(
					(node) => node.nodeType === 1 && ($(node).is(".grid-row") || $(node).find(".grid-row").length),
				),
			);
			if (!rowsChanged) return;
			clearTimeout(frm._adhdBadgeTimer);
			frm._adhdBadgeTimer = setTimeout(() => {
				applySequenceBadges(frm);
				scheduleRouteSummary(frm);
			}, 200);
		});
		frm._adhdRouteObserver.observe(target, { childList: true, subtree: true });
	}

	async function renderRouteSummary(frm) {
		frm.layout.$wrapper.find("#adhd-route-summary").remove();
		frm.layout.$wrapper.find(".adhd-stop-badge").remove();
		if (!frappe.boot?.adhd_mode) return;
		const requestId = (frm._adhdRouteRequest || 0) + 1;
		frm._adhdRouteRequest = requestId;
		const stats = await computeRouteSummary(frm);
		if (requestId !== frm._adhdRouteRequest || !frappe.boot?.adhd_mode || !stats) return;
		const $summary = $(`
			<div id="adhd-route-summary" class="adhd-route-summary" role="status">
				<div class="adhd-route-stat"><span class="adhd-stat-label">${__("Stops")}</span>
					<span class="adhd-stat-value">${stats.totalStops}</span></div>
				<div class="adhd-route-stat"><span class="adhd-stat-label">${__("Distance")}</span>
					<span class="adhd-stat-value">${frappe.utils.escape_html(stats.totalDistance)}</span></div>
				<div class="adhd-route-stat"><span class="adhd-stat-label">${__("Packages")}</span>
					<span class="adhd-stat-value">${format_number(stats.totalPackages)}</span></div>
				<div class="adhd-route-stat adhd-route-first-stop"><span class="adhd-stat-label">${__(
					"First Stop",
				)}</span>
					<span class="adhd-stat-value adhd-first-address" title="${frappe.utils.escape_html(
						stats.firstAddress,
					)}">${frappe.utils.escape_html(stats.firstAddress)}</span></div>
			</div>
		`);
		$(frm.fields_dict.delivery_stops.wrapper).before($summary);
		applySequenceBadges(frm);
		watchGridForBadgeUpdates(frm);
	}

	function scheduleRouteSummary(frm) {
		clearTimeout(frm._adhdRouteTimer);
		frm._adhdRouteTimer = setTimeout(() => renderRouteSummary(frm).catch(() => null), 500);
	}

	function refresh(frm) {
		if (frappe.boot?.adhd_mode) scheduleRouteSummary(frm);
		else {
			frm.layout.$wrapper.find("#adhd-route-summary,.adhd-stop-badge").remove();
			frm._adhdRouteObserver?.disconnect();
			frm._adhdRouteObserver = null;
		}
	}

	if (!$("#adhd-delivery-trip-styles").length) {
		$("<style>", {
			id: "adhd-delivery-trip-styles",
			text: `.adhd-route-summary{display:flex;flex-wrap:wrap;gap:12px;padding:10px 16px;margin-bottom:12px;
				background:var(--subtle-fg);border:1px solid var(--border-color);border-radius:6px;font-size:.85rem}
				.adhd-route-stat{display:flex;flex-direction:column;align-items:center;min-width:80px}
				.adhd-stat-label{font-size:.7rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:.04em}
				.adhd-stat-value{font-size:1.2rem;font-weight:700;color:var(--text-color)}
				.adhd-first-address{font-size:.85rem!important;font-weight:500!important;max-width:220px;overflow:hidden;
					text-overflow:ellipsis;white-space:nowrap}.adhd-stop-badge{display:inline-flex;align-items:center;
					justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--primary);color:#fff;
					font-size:.72rem;font-weight:700;margin-right:6px;flex-shrink:0}`,
		}).appendTo("head");
	}

	frappe.ui.form.on("Delivery Trip", {
		refresh,
		after_save: refresh,
	});
	frappe.ui.form.on("Delivery Stop", {
		delivery_stops_add: scheduleRouteSummary,
		delivery_stops_remove: scheduleRouteSummary,
		address: scheduleRouteSummary,
		customer_address: scheduleRouteSummary,
		delivery_note: scheduleRouteSummary,
	});

	erpnext.adhd.computeRouteSummary = computeRouteSummary;
})();
