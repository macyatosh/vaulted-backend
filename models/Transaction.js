const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  fan: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' }, // null for subscriptions
  type: { type: String, enum: ['subscription', 'ppv'], required: true },
  amountUsd: { type: Number, required: true },
  platformFeeUsd: { type: Number }, // 6% platform cut
  creatorEarningsUsd: { type: Number }, // 94% to creator
  currency: { type: String, default: 'INR' },
  razorpayPaymentId: { type: String },
  razorpayOrderId: { type: String },
  status: { type: String, enum: ['pending', 'succeeded', 'failed', 'refunded'], default: 'pending' },
  notes: { type: String }, // for UPI UTR and manual notes
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);
