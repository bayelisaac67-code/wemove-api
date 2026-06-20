const jwt = require('jsonwebtoken');
const { query } = require('../db');

const authenticate = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorised' });
  }

  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query('SELECT * FROM users WHERE id = $1 AND account_status = $2', [
      payload.userId,
      'ACTIVE',
    ]);
    if (!result.rows.length) {
      return res.status(401).json({ success: false, error: 'User not found or suspended' });
    }
    req.user = result.rows[0];
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
};

const requireVerified = (req, res, next) => {
  if (req.user.verification_status !== 'VERIFIED') {
    return res.status(403).json({
      success: false,
      error: 'Complete verification to perform this action',
    });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.user.is_admin) {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
};

module.exports = { authenticate, requireVerified, requireAdmin };
