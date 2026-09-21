// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors

(() => {
	const FocusPanel = erpnext.adhd.FocusPanel;
	const originalShow = FocusPanel.prototype.show;
	const originalHide = FocusPanel.prototype.hide;
	const originalDestroy = FocusPanel.prototype.destroy;

	FocusPanel.prototype._loadPaymentDigest = function () {
		if (!(frappe.boot && frappe.boot.adhd_mode)) return;
		frappe.call({
			method: "erpnext.accounts.services.adhd_payment_digest.get_payment_digest",
			args: { company: frappe.defaults.get_default("Company") },
			callback: (response) => response.message && this._renderPaymentDigest(response.message),
		});
	};

	FocusPanel.prototype._renderPaymentDigest = function (data) {
		const body = this.panel?.querySelector(".afp-body");
		if (!body) return;
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
				frappe.new_doc("Payment Entry", {
					payment_type: "Receive",
					party_type: "Customer",
					party: button.dataset.customer,
					references: button.dataset.invoices
						.split(",")
						.filter(Boolean)
						.map((name) => ({ reference_doctype: "Sales Invoice", reference_name: name })),
				});
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
