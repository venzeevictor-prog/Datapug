// Role hierarchy: customer < support < admin < super_admin
// Permissions are additive per role — this is the single source of truth for "who can do what".
// To add a new role or permission, only this file needs to change.

const ROLES = ['customer', 'support', 'admin', 'super_admin'];

const PERMISSIONS = {
  customer: [],
  support: [
    'users.view_all',       // view all customer accounts (read-only)
    'orders.view_all',      // view all orders across customers
    'transactions.view_all',// view all wallet transactions
    'support.respond',      // reply in support chat, view all conversations
    'support.close',        // close a conversation
  ],
  admin: [
    'users.view_all',
    'users.suspend',        // activate/deactivate a customer account
    'orders.view_all',
    'orders.refund_any',    // manually refund/cancel any customer's order
    'transactions.view_all',
    'transactions.adjust',  // manually credit/debit a customer's wallet
    'services.manage',      // sync catalog, edit markup, toggle active
    'provider.view_balance',
    'support.respond',
    'support.close',
    'audit.view',
  ],
  super_admin: [
    'users.view_all',
    'users.suspend',
    'users.manage_roles',   // promote/demote other users, including other admins
    'orders.view_all',
    'orders.refund_any',
    'transactions.view_all',
    'transactions.adjust',
    'services.manage',
    'provider.view_balance',
    'support.respond',
    'support.close',
    'audit.view',
  ],
};

// analytics.view (profit/margin reporting) is intentionally admin+ only — support agents
// need order/customer visibility to help people, but revenue and margin figures are
// more sensitive and aren't needed to do that job.
PERMISSIONS.admin.push('analytics.view');
PERMISSIONS.super_admin.push('analytics.view');

// webstats.view (traffic analytics: page views, visitor devices/locations) is a
// separate, narrower permission from analytics.view (which is revenue/profit) —
// support agents don't get it, but it doesn't carry the same sensitivity as margin
// data, so both admin and super_admin get it equally (no costs.view_exact-style split).
PERMISSIONS.admin.push('webstats.view');
PERMISSIONS.super_admin.push('webstats.view');

// costs.view_exact gates the RAW ₦ provider cost figure specifically — narrower than
// analytics.view. admin can see margin %, revenue, and profit (needed to run the
// business day to day), but the literal cost-per-1000 you pay upstream is restricted
// to super_admin, e.g. so a regular admin account can't be used to reverse-engineer
// your supplier relationship or exact cost structure.
// Note: revenue - profit still equals cost arithmetically, so an admin who wants to do
// that subtraction by hand technically can — this restricts DISPLAY, not derivability.
PERMISSIONS.super_admin.push('costs.view_exact');

function hasPermission(role, permission) {
  return (PERMISSIONS[role] || []).includes(permission);
}

// Middleware factory: requirePermission('orders.refund_any')
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

// A user only counts as "staff" (i.e. gets the admin portal) if they have any elevated role.
function isStaff(role) {
  return role === 'support' || role === 'admin' || role === 'super_admin';
}

module.exports = { ROLES, PERMISSIONS, hasPermission, requirePermission, isStaff };
