import { readFileSync } from 'node:fs';

// Falls back to Frappe's default port when the app is not located at <bench>/apps/erpnext
// (e.g. it is soft-linked into a bench), where the relative path below does not resolve.
let webserver_port: string | number = 8000;
try {
	const common_site_config = JSON.parse(
		readFileSync(new URL('../../../sites/common_site_config.json', import.meta.url), 'utf8')
	) as { webserver_port: string | number };
	webserver_port = common_site_config.webserver_port;
} catch {
	// keep the default
}

export default {
	'^/(app|api|assets|files|private)': {
		target: `http://127.0.0.1:${webserver_port}`,
		ws: true,
		router: function (req) {
			const site_name = req.headers?.host?.split(':')[0];
			return `http://${site_name ?? 'localhost'}:${webserver_port}`;
		}
	}
};
