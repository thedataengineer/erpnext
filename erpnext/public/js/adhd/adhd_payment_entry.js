// Priority-sorted outstanding invoice shortlist for Payment Entry.

frappe.provide("erpnext.adhd");

(() => {
	function isActive() {
		return Boolean(frappe.boot?.adhd_mode);
	}

	function bucketInvoices(invoices, today = frappe.datetime.get_today()) {
		const weekEnd = frappe.datetime.add_days(today, 6);
		const buckets = { urgent: [], thisWeek: [], other: [] };
		for (const invoice of invoices || []) {
			if (invoice.due_date && invoice.due_date <= today) buckets.urgent.push(invoice);
			else if (invoice.due_date && invoice.due_date <= weekEnd) buckets.thisWeek.push(invoice);
			else buckets.other.push(invoice);
		}
		const byDueDate = (left, right) =>
			String(left.due_date || "9999-12-31").localeCompare(String(right.due_date || "9999-12-31"));
		Object.values(buckets).forEach((bucket) => bucket.sort(byDueDate));
		return buckets;
	}

	function removeShortlist(frm) {
		frm.layout?.$wrapper?.find("#adhd-invoice-shortlist").remove();
	}

	function referenceKey(invoice) {
		return `${invoice.voucher_type || ""}::${invoice.voucher_no || ""}`;
	}

	function findReference(frm, invoice) {
		return (frm.doc.references || []).find(
			(row) =>
				row.reference_doctype === invoice.voucher_type && row.reference_name === invoice.voucher_no,
		);
	}

	function setAppliedState($row, applied) {
		$row.toggleClass("adhd-row--applied", applied);
		const $input = $row.find(".adhd-apply-invoice");
		$input.prop("checked", applied);
		$row.find(".adhd-apply-label").text(applied ? __("✓ Applied") : __("Apply full amount"));
	}

	function applyInvoice(frm, invoice, $row, apply) {
		const existing = findReference(frm, invoice);
		if (apply && !existing) {
			const child = frm.add_child("references");
			child.reference_doctype = invoice.voucher_type;
			child.reference_name = invoice.voucher_no;
			child.due_date = invoice.due_date;
			child.total_amount = invoice.invoice_amount;
			child.outstanding_amount = invoice.outstanding_amount;
			child.allocated_amount = invoice.outstanding_amount;
			child.bill_no = invoice.bill_no;
			child.payment_term = invoice.payment_term;
			child.payment_term_outstanding = invoice.payment_term_outstanding;
			child.account = invoice.account;
		} else if (!apply && existing) {
			frappe.model.clear_doc(existing.doctype, existing.name);
			frm.doc.references = (frm.doc.references || []).filter((row) => row.name !== existing.name);
		}
		frm.refresh_field("references");
		setAppliedState($row, apply);
	}

	function invoiceRow(frm, invoice) {
		const key = referenceKey(invoice);
		const outstanding = Number(invoice.outstanding_amount) || 0;
		const href = `/app/${frappe.router.slug(invoice.voucher_type)}/${encodeURIComponent(
			invoice.voucher_no,
		)}`;
		const $row = $(`
			<tr data-reference-key="${frappe.utils.escape_html(key)}">
				<td><a href="${href}">${frappe.utils.escape_html(invoice.voucher_no || "")}</a></td>
				<td>${frappe.utils.escape_html(invoice.due_date || __("No due date"))}</td>
				<td class="text-right">${format_currency(outstanding, frm.doc.party_account_currency)}</td>
				<td><label><input type="checkbox" class="adhd-apply-invoice"> <span class="adhd-apply-label">${__(
					"Apply full amount",
				)}</span></label></td>
			</tr>
		`);
		$row.find(".adhd-apply-invoice").on("change", (event) => {
			applyInvoice(frm, invoice, $row, event.currentTarget.checked);
		});
		setAppliedState($row, Boolean(findReference(frm, invoice)));
		return $row;
	}

	function invoiceTable(frm, invoices) {
		const $table = $(`
			<table class="adhd-invoice-table table table-condensed">
				<thead><tr><th>${__("Invoice #")}</th><th>${__("Due Date")}</th>
					<th class="text-right">${__("Outstanding")}</th><th>${__("Apply")}</th></tr></thead>
				<tbody></tbody>
			</table>
		`);
		invoices.forEach((invoice) => $table.find("tbody").append(invoiceRow(frm, invoice)));
		return $table;
	}

	function appendBucket(frm, $panel, title, className, invoices, collapsed = false) {
		if (!invoices.length) return;
		const $content = $("<div>");
		$content.append(invoiceTable(frm, invoices));
		if (collapsed) {
			const $details = $(
				`<details><summary>${frappe.utils.escape_html(`${title} (${invoices.length})`)}</summary></details>`,
			);
			$details.append($content);
			$panel.append($details);
			return;
		}
		$panel.append(
			`<h6 class="adhd-bucket-label ${className}">${frappe.utils.escape_html(
				`${title} (${invoices.length})`,
			)}</h6>`,
		);
		$panel.append($content);
	}

	function renderShortlist(frm, invoices) {
		removeShortlist(frm);
		const field = frm.fields_dict.references;
		if (!field?.wrapper) return;
		const buckets = bucketInvoices(invoices);
		const $panel = $('<div id="adhd-invoice-shortlist" class="adhd-invoice-shortlist">');
		if (buckets.urgent.length) {
			const $header = $('<div class="adhd-shortlist-header">');
			$header.append(
				`<h6 class="adhd-bucket-label adhd-bucket--urgent">${frappe.utils.escape_html(
					`⚠ ${__("Overdue / Due Today")} (${buckets.urgent.length})`,
				)}</h6>`,
			);
			const $applyAll = $(
				`<button type="button" class="btn btn-sm btn-danger adhd-apply-all-urgent">${__(
					"Apply All Overdue",
				)}</button>`,
			);
			$applyAll.on("click", () => {
				buckets.urgent.forEach((invoice) => {
					const key = referenceKey(invoice);
					const $row = $panel
						.find("tr[data-reference-key]")
						.filter((_, row) => row.dataset.referenceKey === key);
					applyInvoice(frm, invoice, $row, true);
				});
			});
			$header.append($applyAll);
			$panel.append($header, invoiceTable(frm, buckets.urgent));
		}
		appendBucket(frm, $panel, __("Due This Week"), "adhd-bucket--soon", buckets.thisWeek);
		appendBucket(frm, $panel, __("All Others"), "", buckets.other, true);
		$(field.wrapper).before($panel);
	}

	async function fetchAndRenderShortlist(frm) {
		removeShortlist(frm);
		if (!isActive() || frm.doc.docstatus !== 0 || !frm.doc.party || !frm.doc.party_type) return;
		const requestId = (frm._adhdInvoiceRequestId || 0) + 1;
		frm._adhdInvoiceRequestId = requestId;
		frm.set_df_property("references", "description", __("Loading outstanding invoices…"));
		try {
			const response = await frappe.call({
				method:
					"erpnext.accounts.doctype.payment_entry.payment_entry.get_outstanding_reference_documents",
				args: {
					args: {
						posting_date: frm.doc.posting_date || frappe.datetime.get_today(),
						company: frm.doc.company,
						party_type: frm.doc.party_type,
						party: frm.doc.party,
						party_account:
							frm.doc.payment_type === "Receive" ? frm.doc.paid_from : frm.doc.paid_to,
						payment_type: frm.doc.payment_type,
						cost_center: frm.doc.cost_center,
						get_outstanding_invoices: true,
					},
				},
			});
			if (requestId !== frm._adhdInvoiceRequestId) return;
			if (response.message?.length) renderShortlist(frm, response.message);
		} catch {
			if (requestId === frm._adhdInvoiceRequestId) removeShortlist(frm);
		} finally {
			if (requestId === frm._adhdInvoiceRequestId) {
				frm.set_df_property("references", "description", "");
			}
		}
	}

	function injectStyles() {
		if ($("#adhd-payment-entry-styles").length) return;
		$("<style>", {
			id: "adhd-payment-entry-styles",
			text: `.adhd-invoice-shortlist{margin-bottom:1rem;border:1px solid var(--border-color);border-radius:4px;padding:8px}
				.adhd-shortlist-header{display:flex;align-items:center;justify-content:space-between}
				.adhd-bucket-label{font-size:.75rem;font-weight:700;text-transform:uppercase;margin:6px 0 4px}
				.adhd-bucket--urgent{color:var(--red-500)}.adhd-bucket--soon{color:var(--yellow-500)}
				.adhd-row--applied{opacity:.5;background:var(--control-bg)}`,
		}).appendTo("head");
	}

	injectStyles();
	frappe.ui.form.on("Payment Entry", {
		party(frm) {
			fetchAndRenderShortlist(frm);
		},
		party_type(frm) {
			frm._adhdInvoiceRequestId = (frm._adhdInvoiceRequestId || 0) + 1;
			removeShortlist(frm);
		},
		refresh(frm) {
			fetchAndRenderShortlist(frm);
		},
	});

	erpnext.adhd.bucketInvoices = bucketInvoices;
})();
