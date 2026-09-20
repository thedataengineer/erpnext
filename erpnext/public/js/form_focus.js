// erpnext/public/js/form_focus.js

// FIELD_HELP dictionary for form field guidance
const FIELD_HELP = {
  // Existing entries...
  
  // Add new entries as needed
  'purchase_order.item_code': 'Enter the exact item code from the warehouse system',
  'sales_invoice.customer_address': 'Select the billing address from the customer profile',
  'stock_entry.transfer_qty': 'This should match the quantity shown in the source warehouse'
};

// Export FIELD_HELP for use in other modules
export { FIELD_HELP };