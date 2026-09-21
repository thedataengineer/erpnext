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

	function saveState(frm) {
		if (!isActive()) return;
		const key = storageKey(frm);
		if (!key) return;
		const $wrapper = transactionWrapper(frm);
		const checkedIds = $wrapper
			.find(`${CHECKBOX}:checked`)
			.map((_, element) => element.dataset.name)
			.get();
		localStorage.setItem(
			key,
			JSON.stringify({
				savedAt: new Date().toISOString(),
				checkedIds,
				total: $wrapper.find(CHECKBOX).length,
			}),
		);
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
		const checked = new Set(state.checkedIds);
		let restored = 0;
		transactionWrapper(frm)
			.find(CHECKBOX)
			.each((_, element) => {
				const shouldCheck = checked.has(element.dataset.name);
				element.checked = shouldCheck;
				if (shouldCheck) restored += 1;
			});
		showResumeBanner(frm, state, restored);
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
			const key = storageKey(frm);
			if (key) localStorage.removeItem(key);
			frm.layout.$wrapper.find("#adhd-recon-banner").remove();
			const result = original.apply(this, args);
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

		$wrapper.on("change.adhdBankRecon", CHECKBOX, () => saveState(frm));
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
})();
