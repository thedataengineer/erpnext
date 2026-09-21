// "Confirmed installed?" checklist on the Installation Note items grid (ADHD-024).
//
// Frappe's Grid has no API for adding a column at run time (`add_custom_column` exists only on Query Report),
// and a tick needs a real field to live in, so the column is a real Custom Field on Installation Note Item,
// `adhd_confirmed_installed` (Check, shipped as a fixture: hidden, and not in the list view). While ADHD mode is
// on this module reveals it in the grid, and puts it back as stock ERPNext ships it when the mode is off. The
// tick is saved with the note like any other field, so it survives a reload and is shared between users. It is
// read-only once the note is submitted, and it never stops a save or a submit.
//
// A site that has not run `bench migrate` since the field was added has no such docfield: everything below then
// quietly does nothing.

frappe.provide("erpnext.adhd");

(() => {
	const DOCTYPE = "Installation Note";
	const ITEM_DOCTYPE = "Installation Note Item";
	const FIELD = "adhd_confirmed_installed";
	const PROGRESS = ".adhd-install-progress";
	// wide enough for the header "Confirmed Installed?"; a Check column is 60px by default
	const COLUMN_WIDTH = 120;

	function isActive() {
		return Boolean(frappe.boot?.adhd_mode);
	}

	// The site's own (shared) docfield, which this module never changes. Null until the site has migrated.
	function siteDocfield() {
		return frappe.meta.get_docfield(ITEM_DOCTYPE, FIELD) || null;
	}

	// Pure: how many rows are ticked. Zero rows is never "complete".
	function countConfirmed(items) {
		const rows = items || [];
		const confirmed = rows.filter((row) => cint(row[FIELD])).length;
		return { confirmed, total: rows.length, complete: rows.length > 0 && confirmed === rows.length };
	}

	// The docfield values the column should have right now: revealed while the mode is on (read-only once the
	// note is submitted or cancelled), otherwise exactly what the site's meta says.
	function wantedColumn(frm, show) {
		const stock = siteDocfield();
		if (!show) {
			return {
				hidden: stock.hidden,
				in_list_view: stock.in_list_view,
				width: stock.width,
				read_only: stock.read_only,
			};
		}
		return {
			hidden: 0,
			in_list_view: 1,
			width: COLUMN_WIDTH,
			read_only: cint(frm.doc.docstatus) === 0 ? stock.read_only : 1,
		};
	}

	// Un-hiding is not enough: the grid only builds columns for fields that are visible AND in the list view, and
	// it remembers that list, so the docfield is changed and the grid rebuilt (`reset_grid`, which Frappe's own
	// "Add / Remove Columns" uses). The change is made on this document's copy of the docfield and on each row's,
	// never on the shared meta.
	function setColumnVisible(frm, show) {
		const grid = frm.fields_dict?.items?.grid;
		const df = grid?.get_docfield?.(FIELD);
		if (!df || df === siteDocfield()) return;

		const wanted = wantedColumn(frm, show);
		// already as wanted (a refresh, or the mode was never on): leave the grid alone, no rebuild
		if (Object.keys(wanted).every((prop) => cint(df[prop]) === cint(wanted[prop]))) return;

		for (const [prop, value] of Object.entries(wanted)) {
			try {
				grid.update_docfield_property(FIELD, prop, value);
			} catch {
				// a row without the field, or a grid not drawn yet: this document's copy is set just below
			}
			df[prop] = value;
		}
		grid.reset_grid();
	}

	function removeProgress(frm) {
		frm.layout?.wrapper?.find(PROGRESS).remove();
	}

	function renderProgress(frm) {
		removeProgress(frm);
		const { confirmed, total, complete } = countConfirmed(frm.doc.items);
		frm._adhdInstallComplete = complete;
		const $anchor = $(frm.fields_dict?.items?.wrapper);
		if (!total || !$anchor.length) return;

		const text = __("{0} of {1} confirmed", [confirmed, total]);
		$anchor.before(
			`<div class="adhd-install-progress${
				complete ? " adhd-install-progress--complete" : ""
			}" role="status">
				<span class="adhd-install-count">${frappe.utils.escape_html(text)}</span>
			</div>`
		);
	}

	// Show or remove everything this module adds, following the mode as it is right now.
	function sync(frm) {
		if (!frm?.doc || frm.doctype !== DOCTYPE) return;
		// not migrated yet: nothing to reveal, nothing to count
		if (!siteDocfield()) return removeProgress(frm);
		const show = isActive();
		setColumnVisible(frm, show);
		if (show) renderProgress(frm);
		else removeProgress(frm);
	}

	function onRowsChanged(frm) {
		if (!isActive() || frm.doctype !== DOCTYPE || !siteDocfield()) return;
		renderProgress(frm);
	}

	function onTick(frm) {
		if (!isActive() || frm.doctype !== DOCTYPE || !siteDocfield()) return;
		const wasComplete = Boolean(frm._adhdInstallComplete);
		renderProgress(frm);
		if (frm._adhdInstallComplete && !wasComplete) {
			frappe.show_alert({ message: __("All items confirmed installed."), indicator: "green" }, 5);
		}
	}

	frappe.ui.form.on(DOCTYPE, { refresh: sync });
	frappe.ui.form.on(ITEM_DOCTYPE, {
		[FIELD]: onTick,
		items_add: onRowsChanged,
		items_remove: onRowsChanged,
	});

	// switched on or off while a note is open: reveal or hide the column at once
	erpnext.adhd.onStateChange?.(() => {
		const frm = window.cur_frm;
		if (frm?.doctype === DOCTYPE && frm.doc) sync(frm);
	});

	erpnext.adhd.countInstallConfirmations = countConfirmed;
	erpnext.adhd.syncInstallationChecklist = sync;
})();
