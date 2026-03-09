const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const User = require('../models/User');
const Post = require('../models/Post');
const Transaction = require('../models/Transaction');
const { protect } = require('../middleware/auth');

const PLATFORM_FEE_PERCENT = 0.06; // 6% platform cut

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── POST /api/payments/ppv/create ───────────────────────
router.post('/ppv/create', protect, async (req, res) => {
  try {
    const { postId } = req.body;
    const fan = req.user;

    const post = await Post.findById(postId).populate('creator', 'displayName slug');
    if (!post || post.status !== 'live') return res.status(404).json({ error: 'Post not found.' });
    if (post.accessType !== 'ppv') return res.status(400).json({ error: 'This post is not pay-per-view.' });
    if (fan.unlockedPosts?.some(id => id.toString() === postId)) return res.status(400).json({ error: 'Already unlocked.' });

    const order = await razorpay.orders.create({
      amount: Math.round(post.ppvPrice * 100), // paise
      currency: 'INR',
      receipt: `ppv_${postId}_${Date.now()}`,
      notes: { type: 'ppv', postId, fanId: fan._id.toString(), creatorId: post.creator._id.toString() },
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      postTitle: post.title,
      fanName: fan.displayName || fan.email,
      fanEmail: fan.email,
    });
  } catch (err) {
    console.error('PPV order error:', err);
    res.status(500).json({ error: 'Failed to create payment order.' });
  }
});

// ── POST /api/payments/ppv/verify ───────────────────────
router.post('/ppv/verify', protect, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, postId } = req.body;
    const fan = req.user;

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed.' });
    }

    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    const amountInr = payment.amount / 100;
    const post = await Post.findById(postId).populate('creator', '_id');
    if (!post) return res.status(404).json({ error: 'Post not found.' });

    await User.findByIdAndUpdate(fan._id, { $addToSet: { unlockedPosts: postId } });

    const creatorEarnings = amountInr * (1 - PLATFORM_FEE_PERCENT);
    await Transaction.create({
      fan: fan._id, creator: post.creator._id, post: postId,
      type: 'ppv', amountUsd: amountInr, currency: 'INR',
      platformFeeUsd: amountInr * PLATFORM_FEE_PERCENT,
      creatorEarningsUsd: creatorEarnings,
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id,
      status: 'succeeded',
    });

    await Post.findByIdAndUpdate(postId, { $inc: { unlockCount: 1, revenue: creatorEarnings } });

    res.json({ success: true, message: 'Payment verified! Content unlocked.' });
  } catch (err) {
    console.error('PPV verify error:', err);
    res.status(500).json({ error: 'Payment verification failed.' });
  }
});

// ── POST /api/payments/subscription/create ──────────────
router.post('/subscription/create', protect, async (req, res) => {
  try {
    const { creatorSlug, interval } = req.body;
    const fan = req.user;

    const creator = await User.findOne({ slug: creatorSlug, role: 'creator' });
    if (!creator) return res.status(404).json({ error: 'Creator not found.' });
    if (fan._id.toString() === creator._id.toString()) return res.status(400).json({ error: 'Cannot subscribe to yourself.' });

    const priceInr = interval === 'year' ? creator.subscriptionAnnualPrice : creator.subscriptionMonthlyPrice;

    const plan = await razorpay.plans.create({
      period: interval === 'year' ? 'yearly' : 'monthly',
      interval: 1,
      item: {
        name: `${creator.displayName} — ${interval === 'year' ? 'Annual' : 'Monthly'} Subscription`,
        amount: Math.round(priceInr * 100),
        currency: 'INR',
      },
      notes: { creatorId: creator._id.toString() },
    });

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan.id,
      total_count: interval === 'year' ? 12 : 120,
      quantity: 1,
      customer_notify: 1,
      notes: { type: 'subscription', fanId: fan._id.toString(), creatorId: creator._id.toString(), interval },
    });

    res.json({
      subscriptionId: subscription.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: Math.round(priceInr * 100),
      currency: 'INR',
      creatorName: creator.displayName,
      fanName: fan.displayName || fan.email,
      fanEmail: fan.email,
    });
  } catch (err) {
    console.error('Subscription create error:', err);
    res.status(500).json({ error: 'Failed to create subscription.' });
  }
});

// ── POST /api/payments/subscription/verify ──────────────
router.post('/subscription/verify', protect, async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, creatorSlug, interval } = req.body;
    const fan = req.user;

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) return res.status(400).json({ error: 'Subscription verification failed.' });

    const creator = await User.findOne({ slug: creatorSlug, role: 'creator' });
    if (!creator) return res.status(404).json({ error: 'Creator not found.' });

    const now = new Date();
    const periodEnd = new Date(now);
    if (interval === 'year') periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    else periodEnd.setMonth(periodEnd.getMonth() + 1);

    await User.findByIdAndUpdate(fan._id, {
      activeSubscription: {
        subscriptionId: razorpay_subscription_id,
        creatorId: creator._id,
        status: 'active',
        currentPeriodEnd: periodEnd,
      },
    });

    const priceInr = interval === 'year' ? creator.subscriptionAnnualPrice : creator.subscriptionMonthlyPrice;
    await Transaction.create({
      fan: fan._id, creator: creator._id,
      type: 'subscription', amountUsd: priceInr, currency: 'INR',
      platformFeeUsd: priceInr * PLATFORM_FEE_PERCENT,
      creatorEarningsUsd: priceInr * (1 - PLATFORM_FEE_PERCENT),
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_subscription_id,
      status: 'succeeded',
    });

    res.json({ success: true, message: 'Subscription activated!' });
  } catch (err) {
    console.error('Subscription verify error:', err);
    res.status(500).json({ error: 'Subscription verification failed.' });
  }
});

// ── POST /api/payments/webhook ───────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.body)
      .digest('hex');

    if (expectedSignature !== signature) return res.status(400).json({ error: 'Invalid webhook signature.' });

    const event = JSON.parse(req.body);

    switch (event.event) {
      case 'subscription.charged': {
        const sub = event.payload.subscription.entity;
        const payment = event.payload.payment.entity;
        const { fanId, creatorId, interval } = sub.notes || {};
        if (fanId && creatorId) {
          const periodEnd = new Date();
          if (interval === 'year') periodEnd.setFullYear(periodEnd.getFullYear() + 1);
          else periodEnd.setMonth(periodEnd.getMonth() + 1);
          await User.findByIdAndUpdate(fanId, {
            'activeSubscription.status': 'active',
            'activeSubscription.currentPeriodEnd': periodEnd,
          });
          const amountInr = payment.amount / 100;
          await Transaction.create({
            fan: fanId, creator: creatorId, type: 'subscription',
            amountUsd: amountInr, currency: 'INR',
            platformFeeUsd: amountInr * PLATFORM_FEE_PERCENT,
            creatorEarningsUsd: amountInr * (1 - PLATFORM_FEE_PERCENT),
            razorpayPaymentId: payment.id, razorpayOrderId: sub.id, status: 'succeeded',
          });
        }
        break;
      }
      case 'subscription.cancelled':
      case 'subscription.halted': {
        const sub = event.payload.subscription.entity;
        const { fanId } = sub.notes || {};
        if (fanId) {
          await User.findByIdAndUpdate(fanId, {
            'activeSubscription.status': event.event === 'subscription.cancelled' ? 'canceled' : 'past_due',
          });
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

// ── GET /api/payments/my-earnings ────────────────────────
router.get('/my-earnings', protect, async (req, res) => {
  try {
    const transactions = await Transaction.find({ creator: req.user._id, status: 'succeeded' })
      .sort({ createdAt: -1 })
      .populate('fan', 'displayName email')
      .populate('post', 'title')
      .lean();

    const totalEarnings = transactions.reduce((sum, t) => sum + (t.creatorEarningsUsd || 0), 0);
    const subscriptionEarnings = transactions.filter(t => t.type === 'subscription').reduce((sum, t) => sum + (t.creatorEarningsUsd || 0), 0);
    const ppvEarnings = transactions.filter(t => t.type === 'ppv').reduce((sum, t) => sum + (t.creatorEarningsUsd || 0), 0);

    res.json({
      totalEarnings: Math.round(totalEarnings * 100) / 100,
      subscriptionEarnings: Math.round(subscriptionEarnings * 100) / 100,
      ppvEarnings: Math.round(ppvEarnings * 100) / 100,
      transactionCount: transactions.length,
      transactions,
      currency: 'INR',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch earnings.' });
  }
});

// ── POST /api/payments/cancel-subscription ───────────────
router.post('/cancel-subscription', protect, async (req, res) => {
  try {
    const fan = req.user;
    if (!fan.activeSubscription?.subscriptionId) return res.status(400).json({ error: 'No active subscription found.' });
    await razorpay.subscriptions.cancel(fan.activeSubscription.subscriptionId, true);
    res.json({ message: 'Subscription will cancel at end of billing period.' });
  } catch (err) {
    console.error('Cancel subscription error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

module.exports = router;
