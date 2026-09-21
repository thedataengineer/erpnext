# ADHD features are imported by erpnext/public/js/erpnext.bundle.js in dependency order.
app_include_js = ["erpnext.bundle.js"]

fixtures = [
	{
		"dt": "Custom Field",
		"filters": [["name", "=", "System Settings-adhd_telemetry_enabled"]],
	}
]
