const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 8,
    select: false, // never returned in queries by default
  },
  displayName: { type: String, trim: true, maxlength: 60 },
  slug: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  bio: { type: String, maxlength: 500 },
  avatarUrl: { type: String },
  role: { type: String, enum: ['creator', 'fan'], default: 'fan' },

  // Creator settings
  subscriptionMonthlyPrice: { type: Number, default: 9.99 },
  subscriptionAnnualPrice: { type: Number, default: 79.99 },
  // Fan subscription state
  activeSubscription: {
    subscriptionId: String,
    creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['active', 'canceled', 'past_due'] },
    currentPeriodEnd: Date,
  },

  // PPV purchases
  unlockedPosts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],

}, { timestamps: true });

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// Never return password
userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.stripeAccountId;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
