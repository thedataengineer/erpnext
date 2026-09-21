import "./utils";
import "./stock_reservation";
import "./queries";
import "./sms_manager";
import "./utils/party";
import "./utils/draft_link_guard";
import "./controllers/stock_controller";
import "./utils/serial_no_batch_selector";
import "./utils/serial_batch_inline_editor";
import "./payment/payments";
import "./templates/visual_plant_floor_template.html";
import "./plant_floor_visual/visual_plant";
import "./templates/shop_floor_template.html";
import "./shop_floor/shop_floor";
import "./controllers/taxes_and_totals";
import "./controllers/transaction";
import "./templates/item_selector.html";
import "./utils/item_selector";
import "./help_links";
import "./templates/item_quick_entry.html";
import "./utils/contact_address_quick_entry";
import "./utils/customer_quick_entry";
import "./utils/supplier_quick_entry";
import "./utils/item_quick_entry";
import "./call_popup/call_popup";
import "./utils/dimension_tree_filter";
import "./utils/ledger_preview.js";
import "./utils/unreconcile.js";
import "./utils/item_close";
import "./utils/barcode_scanner";
import "./telephony";
import "./templates/call_link.html";
import "./bulk_transaction_processing";
import "./utils/crm_activities";
import "./templates/crm_activities.html";
import "./templates/crm_notes.html";
import "./controllers/accounts.js";
import "./utils/landed_taxes_and_charges_common.js";
import "./utils/sales_common.js";
import "./controllers/buying.js";
import "./utils/demo.js";
import "./financial_statements.js";
import "./sales_trends_filters.js";
import "./purchase_trends_filters.js";

// ADHD-Friendly Mode — load in dependency order
import "./adhd/adhd_settings"; // Per-feature settings
import "./adhd/adhd_mode";         // Core toggle (must be first)
import "./adhd/adhd_telemetry"; // Opt-in anonymous interaction signals
import "./adhd/focus_panel";       // Focus panel + Pomodoro timer
import "./adhd/adhd_month_end"; // Month-end close checklist
import "./adhd/adhd_time_log"; // Pomodoro time-log prompt
import "./adhd/adhd_timebox_timer"; // Custom-duration timer API
import "./adhd/adhd_payment_digest"; // Focus Panel receivables summary
import "./adhd/adhd_field_help"; // Canonical contextual field help
import "./adhd/form_focus";        // Form simplification & tooltips
import "./adhd/task_kanban";       // Task Kanban board
import "./adhd/adhd_accounts"; // Journal Entry balance meter
import "./adhd/adhd_buying"; // Purchase Order lifecycle panel
import "./adhd/adhd_notifications"; // Enhanced notifications
import "./adhd/adhd_chain_navigator"; // Workflow document chain navigator
import "./adhd/adhd_smart_inbox"; // Daily priorities and resume panel
import "./adhd/adhd_form_wizard"; // Guided mandatory-field save
import "./adhd/adhd_draft_recovery"; // Sales Order / Quotation interruption restore
import "./adhd/adhd_help"; // Keyboard shortcut reference
import "./adhd/adhd_list_view"; // Due-date heat map
import "./adhd/adhd_deadline_banner"; // Contextual deadline nudges
import "./adhd/adhd_quotation"; // Quotation expiry banner
import "./adhd/adhd_opportunity"; // Opportunity stale badge
import "./adhd/adhd_bank_recon"; // Resumable reconciliation progress
import "./adhd/adhd_payment_entry"; // Outstanding invoice shortlist
import "./adhd/adhd_stock_entry"; // Stock impact and putaway explanations
import "./adhd/adhd_batch_picker"; // Cross-doctype FEFO batch picker
import "./adhd/adhd_stock_reconciliation"; // Quantity variance warnings
import "./adhd/adhd_delivery_trip"; // Route summary and stop sequence
import "./adhd/adhd_tickets_041_061"; // Module-specific ADHD aids
import "./adhd/adhd_customer"; // Customer essentials strip
import "./adhd/adhd_sales_order"; // Sales Order delivery status
import "./adhd/adhd_test_utils"; // Conditional developer test harness

// Assistant: local-LLM chat that fills in forms from plain sentences
import "./assistant/assistant_view";
import "./assistant/assistant_chat";
import "./assistant/assistant_bar";

// import { sum } from 'frappe/public/utils/util.js'
