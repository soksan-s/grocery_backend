import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';

import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const imageExtensions = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
  '.heic',
  '.heif',
  '.avif',
]);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post('/', requireAuth, requireRole('admin'), upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  if (!isImageUpload(req.file)) {
    return res.status(400).json({ error: 'Only image uploads are allowed.' });
  }

  if (!process.env.CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET) {
    return res.status(500).json({ error: 'Cloudinary is not configured.' });
  }

  try {
    const folder = process.env.CLOUDINARY_FOLDER || 'grocery-products';

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
        },
        (error, uploadResult) => {
          if (error) {
            reject(error);
          } else {
            resolve(uploadResult);
          }
        }
      );
      stream.end(req.file.buffer);
    });

    return res.status(201).json({
      url: result.secure_url,
      publicId: result.public_id,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Upload failed.' });
  }
});

function isImageUpload(file) {
  const mimeType = (file.mimetype ?? '').toLowerCase();
  if (mimeType.startsWith('image/')) {
    return true;
  }
  if (mimeType !== 'application/octet-stream') {
    return false;
  }

  const extension = path.extname(file.originalname ?? '').toLowerCase();
  return imageExtensions.has(extension);
}

export default router;
