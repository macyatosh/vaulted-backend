const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 2000 },
  mediaType: { type: String, enum: ['photo', 'video'], required: true },

  // S3 storage
  s3Key: { type: String, required: true },       // full private key
  s3PreviewKey: { type: String },                 // blurred/watermarked preview key
  s3Bucket: { type: String, required: true },
  fileSize: { type: Number },
  mimeType: { type: String },

  // Access control
  accessType: {
    type: String,
    enum: ['free', 'subscription', 'ppv'],
    default: 'free',
  },
  ppvPrice: { type: Number, min: 0.99, max: 999 }, // USD, only if accessType === 'ppv'

  // Status
  status: { type: String, enum: ['draft', 'live', 'archived'], default: 'draft' },

  // Stats
  viewCount: { type: Number, default: 0 },
  unlockCount: { type: Number, default: 0 },
  revenue: { type: Number, default: 0 }, // total USD earned from this post

}, { timestamps: true });

// Index for fast creator gallery queries
postSchema.index({ creator: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Post', postSchema);
