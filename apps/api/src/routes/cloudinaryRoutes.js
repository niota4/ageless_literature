/**
 * Cloudinary Routes
 * Handles signature generation and image management
 */

import express from 'express';
import { generateUploadSignature, deleteImage } from '../utils/cloudinary.js';
import { verifyToken } from '../controllers/authController.js';
import db from '../models/index.js';

const router = express.Router();
const { User, Vendor } = db;

/**
 * POST /api/cloudinary/signature
 * Generate signed upload signature for secure client-side uploads
 */
router.post('/signature', verifyToken, (req, res) => {
  try {
    const { folder, transformation, upload_preset } = req.body;

    const params = {};
    if (folder) params.folder = folder;
    if (transformation) params.transformation = transformation;
    if (upload_preset) params.upload_preset = upload_preset;

    const signatureData = generateUploadSignature(params);

    res.json({
      success: true,
      data: signatureData,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to generate upload signature',
      error: error.message,
    });
  }
});

/**
 * POST /api/cloudinary/delete
 * Delete an image from Cloudinary
 */
router.post('/delete', verifyToken, async (req, res) => {
  try {
    const { publicId } = req.body;

    if (!publicId) {
      return res.status(400).json({
        success: false,
        message: 'Public ID is required',
      });
    }

    const result = await deleteImage(publicId);

    res.json({
      success: true,
      message: 'Image deleted successfully',
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete image',
      error: error.message,
    });
  }
});

/**
 * POST /api/cloudinary/user/profile-image
 * Update user profile image
 */
router.post('/user/profile-image', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { url, publicId } = req.body;

    if (!url || !publicId) {
      return res.status(400).json({
        success: false,
        message: 'Image URL and public ID are required',
      });
    }

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Delete old image if exists
    if (user.profilePhotoPublicId) {
      try {
        await deleteImage(user.profilePhotoPublicId);
      } catch (error) {
        console.error('Failed to delete old profile photo:', error);
      }
    }

    // Update user with new image
    user.profilePhotoUrl = url;
    user.profilePhotoPublicId = publicId;
    await user.save();

    res.json({
      success: true,
      message: 'Profile image updated successfully',
      data: {
        profilePhotoUrl: user.profilePhotoUrl,
        profilePhotoPublicId: user.profilePhotoPublicId,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update profile image',
      error: error.message,
    });
  }
});

/**
 * POST /api/cloudinary/vendor/logo
 * Update vendor logo
 */
router.post('/vendor/logo', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { url, publicId } = req.body;

    if (!url || !publicId) {
      return res.status(400).json({
        success: false,
        message: 'Image URL and public ID are required',
      });
    }

    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found',
      });
    }

    // Delete old image if exists
    if (vendor.logoPublicId) {
      try {
        await deleteImage(vendor.logoPublicId);
      } catch (error) {
        console.error('Failed to delete old logo:', error);
      }
    }

    // Update vendor with new logo
    vendor.logoUrl = url;
    vendor.logoPublicId = publicId;
    await vendor.save();

    res.json({
      success: true,
      message: 'Logo updated successfully',
      data: {
        logoUrl: vendor.logoUrl,
        logoPublicId: vendor.logoPublicId,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update logo',
      error: error.message,
    });
  }
});

/**
 * POST /api/cloudinary/vendor/banner
 * Update vendor banner
 */
router.post('/vendor/banner', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { url, publicId } = req.body;

    if (!url || !publicId) {
      return res.status(400).json({
        success: false,
        message: 'Image URL and public ID are required',
      });
    }

    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found',
      });
    }

    // Delete old image if exists
    if (vendor.bannerPublicId) {
      try {
        await deleteImage(vendor.bannerPublicId);
      } catch (error) {
        console.error('Failed to delete old banner:', error);
      }
    }

    // Update vendor with new banner
    vendor.bannerUrl = url;
    vendor.bannerPublicId = publicId;
    await vendor.save();

    res.json({
      success: true,
      message: 'Banner updated successfully',
      data: {
        bannerUrl: vendor.bannerUrl,
        bannerPublicId: vendor.bannerPublicId,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update banner',
      error: error.message,
    });
  }
});

/**
 * DELETE /api/cloudinary/vendor/logo
 * Remove vendor logo
 */
router.delete('/vendor/logo', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor profile not found' });
    }

    // Delete from Cloudinary if exists
    if (vendor.logoPublicId) {
      try {
        await deleteImage(vendor.logoPublicId);
      } catch (error) {
        console.error('Failed to delete logo from Cloudinary:', error);
      }
    }

    vendor.logoUrl = null;
    vendor.logoPublicId = null;
    await vendor.save();

    res.json({ success: true, message: 'Logo removed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to remove logo', error: error.message });
  }
});

/**
 * DELETE /api/cloudinary/vendor/banner
 * Remove vendor banner
 */
router.delete('/vendor/banner', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor profile not found' });
    }

    // Delete from Cloudinary if exists
    if (vendor.bannerPublicId) {
      try {
        await deleteImage(vendor.bannerPublicId);
      } catch (error) {
        console.error('Failed to delete banner from Cloudinary:', error);
      }
    }

    vendor.bannerUrl = null;
    vendor.bannerPublicId = null;
    await vendor.save();

    res.json({ success: true, message: 'Banner removed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to remove banner', error: error.message });
  }
});

export default router;
