const AWS = require('aws-sdk');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Configure AWS SDK v2
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();

// Allowed MIME types
const ALLOWED_TYPES = {
  'image/jpeg': 'photo',
  'image/jpg': 'photo',
  'image/png': 'photo',
  'image/gif': 'photo',
  'image/webp': 'photo',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'video/x-msvideo': 'video',
};

const fileFilter = (req, file, cb) => {
  if (ALLOWED_TYPES[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type. Allowed: JPG, PNG, GIF, WebP, MP4, MOV, WebM, AVI'), false);
  }
};

// Upload to S3 using multer-s3 v2 (compatible with aws-sdk v2)
const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_S3_BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => {
      cb(null, { uploadedBy: req.user._id.toString() });
    },
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const key = `media/${req.user._id}/${uuidv4()}${ext}`;
      cb(null, key);
    },
  }),
  fileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max
  },
});

// Generate a temporary signed URL for private S3 files
const getSignedUrl = (s3Key, expiresSeconds = 3600) => {
  return s3.getSignedUrlPromise('getObject', {
    Bucket: process.env.AWS_S3_BUCKET,
    Key: s3Key,
    Expires: expiresSeconds,
  });
};

// Delete an object from S3
const deleteS3Object = (s3Key) => {
  return s3.deleteObject({
    Bucket: process.env.AWS_S3_BUCKET,
    Key: s3Key,
  }).promise();
};

module.exports = { upload, getSignedUrl, deleteS3Object, ALLOWED_TYPES };
