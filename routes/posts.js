const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const User = require('../models/User');
const { protect, creatorOnly } = require('../middleware/auth');
const { upload, getSignedUrl, deleteS3Object, ALLOWED_TYPES } = require('../config/s3');

// ── Helper: does this fan have access to a post? ─────────
async function fanHasAccess(fan, post) {
  if (post.accessType === 'free') return true;
  if (!fan) return false;

  if (post.accessType === 'subscription') {
    return (
      fan.activeSubscription?.creatorId?.toString() === post.creator.toString() &&
      fan.activeSubscription?.status === 'active' &&
      fan.activeSubscription?.currentPeriodEnd > new Date()
    );
  }

  if (post.accessType === 'ppv') {
    return fan.unlockedPosts?.some(id => id.toString() === post._id.toString());
  }

  return false;
}

// ── POST /api/posts/upload ───────────────────────────────
// Creator uploads a file to S3
router.post('/upload', protect, creatorOnly, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const { title, description, accessType, ppvPrice, status } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: 'Title is required.' });
    }

    if (accessType === 'ppv') {
      const price = parseFloat(ppvPrice);
      if (isNaN(price) || price < 0.99) {
        return res.status(400).json({ error: 'PPV price must be at least $0.99.' });
      }
    }

    const mediaType = ALLOWED_TYPES[req.file.mimetype] || 'photo';

    const post = await Post.create({
      creator: req.user._id,
      title: title.trim(),
      description: description?.trim(),
      mediaType,
      s3Key: req.file.key,
      s3Bucket: req.file.bucket,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      accessType: accessType || 'free',
      ppvPrice: accessType === 'ppv' ? parseFloat(ppvPrice) : undefined,
      status: status === 'live' ? 'live' : 'draft',
    });

    res.status(201).json({ post });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

// ── GET /api/posts/my ────────────────────────────────────
// Creator fetches their own posts (with stats)
router.get('/my', protect, creatorOnly, async (req, res) => {
  try {
    const posts = await Post.find({ creator: req.user._id })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch posts.' });
  }
});


// ── GET /api/posts/all ───────────────────────────────────
// Public gallery — all live posts from all creators
router.get('/all', async (req, res) => {
  try {
    const posts = await Post.find({ status: 'live' })
      .sort({ createdAt: -1 })
      .populate('creator', 'displayName slug avatarUrl subscriptionMonthlyPrice')
      .select('-s3Key -s3PreviewKey -s3Bucket')
      .lean();

    const postsWithMeta = posts.map(post => ({
      ...post,
      isLocked: post.accessType !== 'free',
      creatorSlug: post.creator?.slug,
      creatorName: post.creator?.displayName,
    }));

    res.json({ posts: postsWithMeta });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load gallery.' });
  }
});

// ── GET /api/posts/creator/:slug ─────────────────────────
// Public gallery for a creator (fan view)
router.get('/creator/:slug', async (req, res) => {
  try {
    const creator = await User.findOne({ slug: req.params.slug, role: 'creator' });
    if (!creator) return res.status(404).json({ error: 'Creator not found.' });

    const posts = await Post.find({ creator: creator._id, status: 'live' })
      .sort({ createdAt: -1 })
      .select('-s3Key -s3PreviewKey -s3Bucket') // don't expose raw S3 keys to public
      .lean();

    // For each post, generate a preview URL (signed, 10 min expiry for locked; 1hr for free)
    const postsWithMeta = posts.map(post => ({
      ...post,
      isLocked: post.accessType !== 'free',
      // Actual signed URL served only via /api/posts/:id/media when access verified
    }));

    res.json({
      creator: {
        displayName: creator.displayName,
        bio: creator.bio,
        avatarUrl: creator.avatarUrl,
        slug: creator.slug,
        subscriptionMonthlyPrice: creator.subscriptionMonthlyPrice,
        subscriptionAnnualPrice: creator.subscriptionAnnualPrice,
      },
      posts: postsWithMeta,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load gallery.' });
  }
});

// ── GET /api/posts/:id/media ─────────────────────────────
// Serve signed S3 URL — only if fan has access
router.get('/:id/media', protect, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post || post.status !== 'live') {
      return res.status(404).json({ error: 'Post not found.' });
    }

    const fan = req.user;
    const hasAccess = await fanHasAccess(fan, post);

    if (!hasAccess) {
      return res.status(403).json({ error: 'Purchase or subscribe to access this content.' });
    }

    // Increment view count
    await Post.findByIdAndUpdate(post._id, { $inc: { viewCount: 1 } });

    const signedUrl = await getSignedUrl(post.s3Key, 3600);
    res.json({ url: signedUrl, expiresIn: 3600 });
  } catch (err) {
    console.error('Media serve error:', err);
    res.status(500).json({ error: 'Failed to generate media URL.' });
  }
});

// ── PATCH /api/posts/:id ─────────────────────────────────
// Creator updates a post
router.patch('/:id', protect, creatorOnly, async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, creator: req.user._id });
    if (!post) return res.status(404).json({ error: 'Post not found.' });

    const allowed = ['title', 'description', 'accessType', 'ppvPrice', 'status'];
    allowed.forEach(field => {
      if (req.body[field] !== undefined) post[field] = req.body[field];
    });

    await post.save();
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update post.' });
  }
});

// ── DELETE /api/posts/:id ────────────────────────────────
router.delete('/:id', protect, creatorOnly, async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, creator: req.user._id });
    if (!post) return res.status(404).json({ error: 'Post not found.' });

    // Remove from S3
    await deleteS3Object(post.s3Key);
    if (post.s3PreviewKey) await deleteS3Object(post.s3PreviewKey);

    await post.deleteOne();
    res.json({ message: 'Post deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete post.' });
  }
});

module.exports = router;
