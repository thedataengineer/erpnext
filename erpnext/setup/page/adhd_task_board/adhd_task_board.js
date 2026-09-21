function is_task_board_enabled() {
	if (frappe.boot && Object.prototype.hasOwnProperty.call(frappe.boot, "adhd_mode")) {
		return Boolean(frappe.boot.adhd_mode);
	}

	return Boolean(erpnext.adhd && erpnext.adhd.isActive && erpnext.adhd.isActive());
}

// Shows the board when ADHD mode is on and a short how-to message when it is off. It never
// switches the mode on by itself. Safe to call repeatedly: it only rebuilds when the state changes.
function render_task_board(page) {
	const state = is_task_board_enabled() ? "board" : "off";

	if (page.__adhd_task_board_state === state) {
		if (state === "board" && erpnext.adhd.taskKanban) erpnext.adhd.taskKanban.refresh();
		return;
	}

	if (state === "board" && !(erpnext.adhd && erpnext.adhd.TaskKanban)) return;

	page.__adhd_task_board_state = state;
	page.body.empty();

	if (state === "off") {
		erpnext.adhd.taskKanban = null;
		window.TaskKanban = null;
		$('<div class="adhd-task-board-off text-muted">')
			.css({ padding: "48px 16px", "text-align": "center" })
			.append($("<p>").text(__("The Task Board is part of Focus Mode, which is switched off.")))
			.append(
				$("<p>").text(
					__(
						"Switch it on with the Focus button in the top bar (or press Alt+A), then open this page again."
					)
				)
			)
			.appendTo(page.body);
		return;
	}

	// a fresh container each time, so the board's delegated listeners never stack up
	const $container = $('<div class="adhd-task-board-container">').appendTo(page.body);
	erpnext.adhd.taskKanban = new erpnext.adhd.TaskKanban($container[0]);
	window.TaskKanban = erpnext.adhd.taskKanban;
}

// Frappe calls on_page_load once, when the page is created, and on_page_show straight after it
// (and on every later visit). The page is always created here; what it shows comes from
// render_task_board, which on_page_show and a mode change both call.
frappe.pages["adhd-task-board"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Task Board"),
		single_column: true,
	});

	frappe.adhd_task_board_page = page;

	// onStateChange runs the callback once straight away; on_page_show covers that first render
	let listening = false;
	if (erpnext.adhd && erpnext.adhd.onStateChange) {
		erpnext.adhd.onStateChange(() => {
			if (listening && frappe.get_route_str() === "adhd-task-board") render_task_board(page);
		});
	}
	listening = true;
};

frappe.pages["adhd-task-board"].on_page_show = function () {
	if (frappe.adhd_task_board_page) render_task_board(frappe.adhd_task_board_page);
};
