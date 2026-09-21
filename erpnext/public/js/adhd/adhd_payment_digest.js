// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors

(() => {
	const FocusPanel = erpnext.adhd.FocusPanel;
	const originalShow = FocusPanel.prototype.show;
	const originalHide = FocusPanel.prototype.hide;
	const originalDestroy = FocusPanel.prototype.destroy;

	// Load the receivables summary without ever raising a dialog: it runs every time the panel is shown and
	// every ten minutes, and a user with no default Company or no Sales Invoice access cannot use it.
	FocusPanel.prototype._loadPaymentDigest = async function () {
		if (!(frappe.boot && frappe.boot.adhd_mode)) return;
		// the server refuses a user who cannot read Sales Invoices, so do not ask
		if (!frappe.model.can_read("Sales Invoice")) return this._renderPaymentDigest(null);
		try {
			const response = await frappe.call({
				method: "erpnext.accounts.services.adhd_payment_digest.get_payment_digest",
				args: { company: frappe.defaults.get_default("Company") },
				silent: true,
			});
			this._renderPaymentDigest(response?.message || null);
		} catch {
			this._renderPaymentDigest(null);
		}
	};

	// The section is created by the first render, whether that shows the summary or the unavailable note.
	function paymentSection(body) {
		let section = body.querySelector(".adhd-payment-section");
		if (!section) {
			section = document.createElement("section");
			section.className = "adhd-payment-section";
			section.innerHTML = `<button type="button" class="adhd-payment-header" aria-expanded="true">
				<span class="adhd-payment-title">${__("💰 Payment Summary")}</span><span class="adhd-payment-toggle">▾</span>
			</button><div class="adhd-payment-body"></div>`;
			body.appendChild(section);
			section.querySelector(".adhd-payment-header").addEventListener("click", (event) => {
				const paymentBody = section.querySelector(".adhd-payment-body");
				const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
				event.currentTarget.setAttribute("aria-expanded", String(!expanded));
				paymentBody.hidden = expanded;
				section.querySelector(".adhd-payment-toggle").textContent = expanded ? "▸" : "▾";
			});
		}
		return section;
	}

	// Payment Entry is created empty and ERPNext's own party handler then clears its references table
	// (payment_entry.js), so invoices handed over as rows are lost. Wait for that handler to finish, then
	// let ERPNext's get_outstanding_documents load exactly these invoices the supported way.
	function loadInvoicesIntoPaymentEntry(invoices, previousDocname) {
		if (!invoices.length) return;
		let attempts = 50;
		const timer = setInterval(() => {
			attempts -= 1;
			const frm = window.cur_frm;
			if (attempts <= 0 || !frm) return clearInterval(timer);
			// still on the form the user came from, or not the new entry yet
			if (frm.doctype !== "Payment Entry" || frm.docname === previousDocname || !frm.is_new()) return;
			// the party account is set by ERPNext's party handler, which raises this flag while it works
			if (!frm.doc.party || !frm.doc.paid_from || frm.set_party_account_based_on_party) return;
			clearInterval(timer);
			frm.events.get_outstanding_documents(
				frm,
				{
					vouchers: invoices.map((name) => ({ voucher_type: "Sales Invoice", voucher_no: name })),
					allocate_payment_amount: 1,
				},
				true,
				false,
			);
		}, 200);
	}

	FocusPanel.prototype._renderPaymentDigest = function (data) {
		const body = this.panel?.querySelector(".afp-body");
		if (!body) return;
		const section = paymentSection(body);
		if (!data) {
			section.querySelector(".adhd-payment-body").innerHTML = `<p class="adhd-payment-empty">${__(
				"Payment summary is not available.",
			)}</p>`;
			return;
		}
		const format = (amount) => format_currency(amount, data.currency);
		const rows = (items, label) =>
			items.length
				? items
						.map(
							(item) => `<div class="adhd-payment-row">
								<span class="adhd-payment-customer">${frappe.utils.escape_html(item.customer)}</span>
								<span class="adhd-payment-amount">${format(item.total)}</span>
								<button type="button" class="btn btn-xs btn-primary adhd-payment-create"
									data-customer="${frappe.utils.escape_html(item.customer)}"
									data-invoices="${frappe.utils.escape_html(item.invoices.join(","))}">${__("Create Payment Entry")}</button>
							</div>`,
						)
						.join("")
				: `<p class="adhd-payment-empty">${__("No {0} invoices", [label])}</p>`;
		section.querySelector(".adhd-payment-body").innerHTML = `
			<div class="adhd-payment-total">${__("Total Outstanding")}: <strong>${format(data.total_outstanding)}</strong></div>
			<h5 class="adhd-payment-subhead">${__("Overdue")}</h5>${rows(data.overdue || [], "overdue")}
			<h5 class="adhd-payment-subhead">${__("Due This Week")}</h5>${rows(data.due_this_week || [], "due-this-week")}`;
		section.querySelectorAll(".adhd-payment-create").forEach((button) => {
			button.addEventListener("click", () => {
				const previousDocname = window.cur_frm?.docname;
				frappe.new_doc("Payment Entry", {
					payment_type: "Receive",
					party_type: "Customer",
					party: button.dataset.customer,
				});
				loadInvoicesIntoPaymentEntry(
					button.dataset.invoices.split(",").filter(Boolean),
					previousDocname,
				);
			});
		});
	};

	FocusPanel.prototype.show = function () {
		const result = originalShow.call(this);
		this._loadPaymentDigest();
		clearInterval(this._paymentDigestInterval);
		this._paymentDigestInterval = setInterval(() => this._loadPaymentDigest(), 10 * 60 * 1000);
		return result;
	};

	FocusPanel.prototype.hide = function () {
		clearInterval(this._paymentDigestInterval);
		this._paymentDigestInterval = null;
		return originalHide.call(this);
	};

	FocusPanel.prototype.destroy = function () {
		clearInterval(this._paymentDigestInterval);
		return originalDestroy.call(this);
	};
})();
