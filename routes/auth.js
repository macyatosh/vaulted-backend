const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect, signToken } = require('../middleware/auth');

// ── POST /api/auth/register ──────────────────────────────
// Create a new account (creator or fan)
router.post('/register', async (req, res) => {
  try {
    const { email, password, displayName, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const user = await User.create({
      email,
      password,
      displayName: displayName || email.split('@')[0],
      role: role === 'creator' ? 'creator' : 'fan',
    });

    // Auto-generate slug for creators
    if (user.role === 'creator') {
      user.slug = user.displayName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + user._id.toString().slice(-4);
      await user.save();
    }

    const token = signToken(user._id);
    res.status(201).json({ token, user: user.toSafeObject() });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken(user._id);
    res.json({ token, user: user.toSafeObject() });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────
// Get current logged-in user
router.get('/me', protect, async (req, res) => {
  res.json({ user: req.user.toSafeObject() });
});

// ── PATCH /api/auth/profile ──────────────────────────────
// Update profile info
router.patch('/profile', protect, async (req, res) => {
  try {
    const allowed = ['displayName', 'bio', 'slug', 'subscriptionMonthlyPrice', 'subscriptionAnnualPrice'];
    const updates = {};
    allowed.forEach(field => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    // Validate slug uniqueness
    if (updates.slug) {
      updates.slug = updates.slug.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const taken = await User.findOne({ slug: updates.slug, _id: { $ne: req.user._id } });
      if (taken) return res.status(409).json({ error: 'That URL slug is already taken.' });
    }

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
    res.json({ user: user.toSafeObject() });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Profile update failed.' });
  }
});

// ── POST /api/auth/change-password ──────────────────────
router.post('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Both current and new password are required.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Password change failed.' });
  }
});


// ── POST /api/auth/creator-setup ────────────────────────
// Secret one-time route to create the creator account
// Protected by a setup secret key
router.post('/creator-setup', async (req, res) => {
  try {
    const { email, password, displayName, setupKey } = req.body;

    // Must provide the secret setup key from env
    if (setupKey !== process.env.CREATOR_SETUP_KEY) {
      return res.status(403).json({ error: 'Invalid setup key.' });
    }

    const existing = await User.findOne({ role: 'creator' });
    if (existing) {
      return res.status(409).json({ error: 'Creator account already exists.' });
    }

    const user = await User.create({
      email,
      password,
      displayName: displayName || 'Tanya',
      role: 'creator',
    });

    user.slug = 'tanya';
    await user.save();

    const token = signToken(user._id);
    res.status(201).json({ token, user: user.toSafeObject(), message: 'Creator account created!' });
  } catch (err) {
    console.error('Creator setup error:', err);
    res.status(500).json({ error: 'Setup failed.' });
  }
});

module.exports = router;
