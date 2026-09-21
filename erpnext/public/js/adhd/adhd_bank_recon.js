// Resumable Bank Reconciliation progress for ADHD mode.

frappe.provide("erpnext.adhd");

(() => {
	const CHECKBOX = ".adhd-recon-checkbox";

	function isActive() {
		return Boolean(frappe.boot?.adhd_mode);
	}

	function storageKey(frm) {
		const account = frm.doc.bank_account || "";
		const fromDate = frm.doc.bank_statement_from_date || "";
		return account && fromDate ? `adhd_bank_recon_${account}_${fromDate}` : null;
	}

	function readState(key) {
		try {
			const state = JSON.parse(localStorage.getItem(key));
			return Array.isArray(state?.checkedIds) ? state : null;
		} catch {
			localStorage.removeItem(key);
			return null;
		}
	}

	function transactionWrapper(frm) {
		return $(frm.get_field("reconciliation_tool_dt")?.wrapper);
	}

	// The datatable only keeps the rows in view in the DOM (clusterize), so ticks are tracked in a set that
	// outlives the rendered checkboxes instead of being read back from them.
	function checkedIds(frm, key) {
		if (frm._adhdReconChecked?.key !== key) {
			frm._adhdReconChecked = { key, ids: new Set(readState(key)?.checkedIds || []) };
		}
		return frm._adhdReconChecked.ids;
	}

	function persistState(frm, key) {
		const $wrapper = transactionWrapper(frm);
		const transactions = frm.bank_reconciliation_data_table_manager?.transactions;
		localStorage.setItem(
			key,
			JSON.stringify({
				savedAt: new Date().toISOString(),
				checkedIds: [...checkedIds(frm, key)],
				total: transactions?.length ?? $wrapper.find(CHECKBOX).length,
			}),
		);
	}

	function setChecked(frm, name, checked) {
		if (!isActive() || !name) return;
		const key = storageKey(frm);
		if (!key) return;
		const ids = checkedIds(frm, key);
		if (checked) ids.add(name);
		else ids.delete(name);
		persistState(frm, key);
	}

	// A reconciled transaction leaves the list, so only its own tick goes; the rest of the session stays.
	function forgetTransaction(frm, name) {
		const key = storageKey(frm);
		if (!key || !name) return;
		if (checkedIds(frm, key).delete(name)) persistState(frm, key);
	}

	function showResumeBanner(frm, state, restored) {
		const key = storageKey(frm);
		const $wrapper = transactionWrapper(frm);
		frm.layout.$wrapper.find("#adhd-recon-banner").remove();
		if (!key || !restored || !$wrapper.length) return;

		const savedTime = new Date(state.savedAt);
		const formattedTime = Number.isNaN(savedTime.getTime())
			? __("an earlier session")
			: savedTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		const $banner = $(`
			<div id="adhd-recon-banner" class="alert alert-info" role="status"
				style="margin:8px 0;display:flex;justify-content:space-between;align-items:center;">
				<span>${__(
					"Resumed your reconciliation session from {0}. {1} of {2} transactions matched.",
					[formattedTime, restored, state.total],
				)}</span>
				<a href="#" class="adhd-clear-recon-session">${__("Clear saved session")}</a>
			</div>
		`);
		$banner.find(".adhd-clear-recon-session").on("click", (event) => {
			event.preventDefault();
			localStorage.removeItem(key);
			frm._adhdReconChecked = null;
			$wrapper.find(CHECKBOX).prop("checked", false);
			$banner.remove();
		});
		$wrapper.before($banner);
	}

	function restoreState(frm) {
		if (!isActive()) return;
		const key = storageKey(frm);
		const state = key && readState(key);
		if (!state) return;
		const checked = checkedIds(frm, key);
		transactionWrapper(frm)
			.find(CHECKBOX)
			.each((_, element) => {
				element.checked = checked.has(element.dataset.name);
			});
		showResumeBanner(frm, state, checked.size);
	}

	function decorateTransactions(frm) {
		if (!isActive()) return;
		const $wrapper = transactionWrapper(frm);
		if (!$wrapper.length) return;

		$wrapper.find(".btn[data-name]").each((_, button) => {
			const $button = $(button);
			const name = $button.attr("data-name");
			const alreadyDecorated = $button
				.siblings(CHECKBOX)
				.filter((_, checkbox) => checkbox.dataset.name === name).length;
			if (!name || alreadyDecorated) return;
			$button.before(
				`<input type="checkbox" class="adhd-recon-checkbox" data-name="${frappe.utils.escape_html(
					name,
				)}" aria-label="${__("Mark transaction progress")}"> `,
			);
		});
		restoreState(frm);
		wrapSuccessfulReconciliation(frm);
	}

	function wrapSuccessfulReconciliation(frm) {
		const manager = frm.bank_reconciliation_data_table_manager;
		if (!manager || manager._adhdProgressWrapped) return;
		const original = manager.update_dt_cards;
		manager.update_dt_cards = function (...args) {
			frm.layout.$wrapper.find("#adhd-recon-banner").remove();
			const result = original.apply(this, args);
			forgetTransaction(frm, args[0]?.name);
			setTimeout(() => decorateTransactions(frm), 0);
			return result;
		};
		manager._adhdProgressWrapped = true;
	}

	function initialize(frm) {
		const $wrapper = transactionWrapper(frm);
		$wrapper.off("change.adhdBankRecon", CHECKBOX);
		frm.layout.$wrapper.find("#adhd-recon-banner").remove();
		frm._adhdReconObserver?.disconnect();
		frm._adhdReconObserver = null;
		if (!isActive()) {
			$wrapper.find(CHECKBOX).remove();
			return;
		}
		if (!$wrapper.length) return;

		$wrapper.on("change.adhdBankRecon", CHECKBOX, (event) =>
			setChecked(frm, event.currentTarget.dataset.name, event.currentTarget.checked),
		);
		frm._adhdReconObserver = new MutationObserver(
			frappe.utils.debounce(() => decorateTransactions(frm), 100),
		);
		frm._adhdReconObserver.observe($wrapper[0], { childList: true, subtree: true });
		setTimeout(() => decorateTransactions(frm), 450);
	}

	frappe.ui.form.on("Bank Reconciliation Tool", {
		refresh: initialize,
		render: initialize,
		bank_account: initialize,
		bank_statement_from_date: initialize,
	});

	erpnext.adhd.bankReconStorageKey = storageKey;
	erpnext.adhd.readBankReconState = readState;
	erpnext.adhd.setBankReconChecked = setChecked;
	erpnext.adhd.forgetBankReconTransaction = forgetTransaction;
})();
