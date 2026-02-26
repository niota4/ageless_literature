/**
 * Vendor Products Controller
 * Handles vendor-specific product/book management
 */

import db from '../models/index.js';
import { Op, Sequelize } from 'sequelize';
import { indexBook, removeBookFromIndex } from '../utils/meilisearch.js';

const { Book, Vendor, BookMedia, Category, BookCategory } = db;

// User IDs whose auction wins are treated as "expired" (not real sales)
const EXPIRED_AUCTION_WINNER_IDS = [77];

/**
 * Get all products for the authenticated vendor
 * GET /api/vendor/products
 */
export const getVendorProducts = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const {
      page = 1,
      limit = 20,
      search,
      category,
      condition,
      status,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
      auctionStatus = '', // 'live_auction', 'auction_sold', 'expired_auction'
      excludeAuction = '', // 'true' to exclude books with any auction history
    } = req.query;

    // Get vendor profile
    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found',
      });
    }

    // Build where clause
    const where = { vendorId: vendor.id };

    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { author: { [Op.iLike]: `%${search}%` } },
        { isbn: { [Op.iLike]: `%${search}%` } },
      ];
    }

    if (category) where.category = category;
    if (condition) where.condition = condition;
    if (status === 'archived' && !auctionStatus) {
      where.status = 'archived';
    } else if (status && status !== 'all' && !auctionStatus) {
      where.status = status;
    } else {
      // Default for all other cases (including auction tabs): exclude archived
      where.status = { [Op.ne]: 'archived' };
    }

    // Auction-based filtering via subqueries
    const expiredWinnerIds = EXPIRED_AUCTION_WINNER_IDS.join(',');

    if (auctionStatus === 'live_auction') {
      if (!where[Op.and]) where[Op.and] = [];
      where[Op.and].push(
        Sequelize.literal(`"Book"."id" IN (SELECT book_id FROM auctions WHERE status = 'active' AND book_id IS NOT NULL)`)
      );
    } else if (auctionStatus === 'auction_sold') {
      if (!where[Op.and]) where[Op.and] = [];
      where[Op.and].push(
        Sequelize.literal(`"Book"."id" IN (
          SELECT sub.book_id FROM (
            SELECT DISTINCT ON (book_id) book_id, status as a_status, winner_id
            FROM auctions WHERE book_id IS NOT NULL
            ORDER BY book_id, created_at DESC
          ) sub
          WHERE sub.a_status IN ('ended', 'ended_sold')
            AND sub.winner_id IS NOT NULL
            AND sub.winner_id NOT IN (${expiredWinnerIds})
        )`)
      );
    } else if (auctionStatus === 'expired_auction') {
      if (!where[Op.and]) where[Op.and] = [];
      where[Op.and].push(
        Sequelize.literal(`"Book"."id" IN (
          SELECT sub.book_id FROM (
            SELECT DISTINCT ON (book_id) book_id, status as a_status, winner_id
            FROM auctions WHERE book_id IS NOT NULL
            ORDER BY book_id, created_at DESC
          ) sub
          WHERE sub.a_status IN ('ended', 'ended_no_bids', 'ended_sold')
            AND (sub.winner_id IS NULL OR sub.winner_id IN (${expiredWinnerIds}))
        )`)
      );
    }

    // Exclude books with any auction history (used by Published tab)
    if (excludeAuction === 'true') {
      if (!where[Op.and]) where[Op.and] = [];
      where[Op.and].push(
        Sequelize.literal(`"Book"."id" NOT IN (SELECT book_id FROM auctions WHERE book_id IS NOT NULL)`)
      );
    }

    // Fetch products
    const { count, rows: products } = await Book.findAndCountAll({
      where,
      include: [
        {
          model: BookMedia,
          as: 'media',
          attributes: ['id', 'imageUrl', 'thumbnailUrl', 'isPrimary', 'displayOrder'],
          required: false,
          separate: true, // Important: Load media separately to avoid left join issues
          limit: 3, // Get up to 3 images
          order: [
            ['isPrimary', 'DESC'],
            ['displayOrder', 'ASC'],
          ],
        },
      ],
      order: [[sortBy, sortOrder]],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit),
    });

    // Transform products to match frontend expectations
    const bookIds = products.map((p) => p.id);

    // Fetch latest auction info for books in this page
    let auctionMap = {};
    if (bookIds.length > 0) {
      const auctionRows = await db.sequelize.query(`
        SELECT DISTINCT ON (a.book_id) a.book_id, a.id as auction_id, a.status as auction_status,
               a.winner_id, a.current_bid, a.starting_bid, a.ends_at, a.bid_count
        FROM auctions a
        WHERE a.book_id IN (:bookIds) AND a.book_id IS NOT NULL
        ORDER BY a.book_id, a.created_at DESC
      `, { replacements: { bookIds }, type: db.sequelize.QueryTypes.SELECT });

      for (const row of auctionRows) {
        let auctionCategory = null;
        if (row.auction_status === 'active') {
          auctionCategory = 'live_auction';
        } else if (['ended', 'ended_sold'].includes(row.auction_status) && row.winner_id && !EXPIRED_AUCTION_WINNER_IDS.includes(row.winner_id)) {
          auctionCategory = 'auction_sold';
        } else if (['ended', 'ended_no_bids', 'ended_sold'].includes(row.auction_status)) {
          auctionCategory = 'expired_auction';
        }
        auctionMap[row.book_id] = {
          auctionId: row.auction_id,
          auctionStatus: row.auction_status,
          auctionCategory,
          currentBid: row.current_bid ? parseFloat(row.current_bid) : null,
          startingBid: row.starting_bid ? parseFloat(row.starting_bid) : null,
          endsAt: row.ends_at,
          bidCount: row.bid_count || 0,
        };
      }
    }

    const transformedProducts = products.map((product) => {
      const productData = product.toJSON();

      // Get primary image or first image from media array
      const primaryImage = productData.media?.find((m) => m.isPrimary);
      const firstImage = productData.media?.[0];
      const imageSource = primaryImage || firstImage;

      return {
        ...productData,
        inventory: productData.quantity || 0, // Map quantity to inventory for frontend
        imageUrl: imageSource?.imageUrl || imageSource?.thumbnailUrl || null, // Get image from media
        status: productData.status || 'draft', // Ensure status is present
        auction: auctionMap[productData.id] || null,
      };
    });

    return res.json({
      success: true,
      data: transformedProducts,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching vendor products:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: error.message,
    });
  }
};

/**
 * Get single product detail
 * GET /api/vendor/products/:id
 */
export const getVendorProduct = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { id } = req.params;

    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found',
      });
    }

    const product = await Book.findOne({
      where: { id, vendorId: vendor.id },
      include: [
        {
          model: BookMedia,
          as: 'media',
        },
        {
          model: Category,
          as: 'categories',
          through: { attributes: [] },
        },
      ],
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Transform product to match frontend expectations
    const productData = product.toJSON();

    // Get primary image or first image from media array
    const primaryImage = productData.media?.find((m) => m.isPrimary);
    const firstImage = productData.media?.[0];
    const imageSource = primaryImage || firstImage;

    // Normalize JSONB description to string
    const normalizeDescription = (desc) => {
      if (desc && typeof desc === 'object') {
        return desc.html || desc.en || '';
      }
      return desc || '';
    };

    const transformedProduct = {
      ...productData,
      description: normalizeDescription(productData.description),
      fullDescription: normalizeDescription(productData.fullDescription),
      inventory: productData.quantity || 0, // Map quantity to inventory for frontend
      imageUrl: imageSource?.imageUrl || imageSource?.thumbnailUrl || null, // Get image from media
      status: productData.status || 'draft', // Ensure status is present
    };

    return res.json({
      success: true,
      data: transformedProduct,
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch product',
      error: error.message,
    });
  }
};

/**
 * Create new product
 * POST /api/vendor/products
 */
export const createProduct = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const {
      title,
      author,
      isbn,
      description,
      shortDescription,
      price,
      salePrice,
      quantity,
      condition,
      conditionNotes,
      category,
      categoryIds,
      publisher,
      publicationYear,
      edition,
      language = 'English',
      binding,
      isSigned = false,
      status = 'draft',
      images = [],
      shippingWeight,
      shippingDimensions,
      sellerNotes,
      metaTitle,
      metaDescription,
      menuOrder,
    } = req.body;

    // Validation
    if (!title || !price || !condition) {
      return res.status(400).json({
        success: false,
        message: 'Title, price, and condition are required',
      });
    }

    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found',
      });
    }

    // Map frontend status values to valid DB enum values
    // DB enum: draft, pending, published, sold, archived (no "active")
    const statusMap = { active: 'published' };
    const dbStatus = statusMap[status] || status;

    // Create product
    const product = await Book.create({
      vendorId: vendor.id,
      title,
      author,
      isbn,
      description: typeof description === 'string' ? { html: description } : description,
      shortDescription: shortDescription || null,
      price: price || 0,
      salePrice: salePrice === '' || salePrice === undefined ? null : salePrice,
      quantity: quantity || 1,
      condition,
      conditionNotes,
      category,
      publisher,
      publicationYear:
        publicationYear === '' || publicationYear === undefined ? null : publicationYear,
      edition,
      language,
      binding,
      isSigned,
      status: dbStatus,
      shippingWeight: shippingWeight === '' ? null : shippingWeight,
      shippingDimensions,
      sellerNotes,
      metaTitle,
      metaDescription,
      menuOrder: parseInt(menuOrder) || 0,
    });

    // Handle category associations
    const categoryIdArray = Array.isArray(categoryIds) ? categoryIds : [];
    if (categoryIdArray.length > 0) {
      const categoryRecords = categoryIdArray.map((categoryId) => ({
        bookId: product.id,
        categoryId: parseInt(categoryId),
      }));
      await BookCategory.bulkCreate(categoryRecords, {
        ignoreDuplicates: true,
      });
    }

    // Handle image uploads if provided
    const imageArray = Array.isArray(images) ? images : [];
    if (imageArray.length > 0) {
      const mediaRecords = imageArray.map((img, index) => ({
        bookId: product.id,
        imageUrl: img.url,
        thumbnailUrl: img.thumbnail || img.url,
        displayOrder: index,
      }));
      await BookMedia.bulkCreate(mediaRecords);
    }

    // Fetch complete product with media and categories
    const completeProduct = await Book.findByPk(product.id, {
      include: [
        { model: BookMedia, as: 'media' },
        { model: Category, as: 'categories', through: { attributes: [] } },
      ],
    });

    // Index in Meilisearch (async, don't wait)
    indexBook(product.id).catch((err) => console.error('Failed to index book:', err));

    return res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: completeProduct,
    });
  } catch (error) {
    console.error('Error creating product:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create product',
      error: error.message,
    });
  }
};

/**
 * Update product
 * PUT /api/vendor/products/:id
 */
export const updateProduct = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { id } = req.params;

    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found',
      });
    }

    const product = await Book.findOne({
      where: { id, vendorId: vendor.id },
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Update allowed fields
    const allowedUpdates = [
      'title',
      'author',
      'isbn',
      'description',
      'shortDescription',
      'price',
      'salePrice',
      'quantity',
      'condition',
      'conditionNotes',
      'category',
      'publisher',
      'publicationYear',
      'edition',
      'language',
      'binding',
      'isSigned',
      'status',
      'shippingWeight',
      'shippingDimensions',
      'sellerNotes',
      'metaTitle',
      'metaDescription',
      'menuOrder',
    ];

    // Map frontend status values to valid DB enum values
    const statusMap = { active: 'published' };

    // Fields that must be numeric (not empty strings)
    const numericFields = [
      'price',
      'salePrice',
      'quantity',
      'publicationYear',
      'shippingWeight',
      'views',
      'menuOrder',
    ];
    const sanitizeNumeric = (val) => {
      if (val === '' || val === undefined || val === null) return null;
      const num = Number(val);
      return isNaN(num) ? null : num;
    };

    const updates = {};
    allowedUpdates.forEach((field) => {
      if (req.body[field] !== undefined) {
        // Wrap description in JSONB format if it's a plain string
        if (field === 'description' && typeof req.body[field] === 'string') {
          updates[field] = { html: req.body[field] };
        } else if (field === 'status') {
          updates[field] = statusMap[req.body[field]] || req.body[field];
        } else if (numericFields.includes(field)) {
          updates[field] = sanitizeNumeric(req.body[field]);
        } else {
          updates[field] = req.body[field];
        }
      }
    });

    await product.update(updates);

    // Handle image updates if provided
    if (req.body.images !== undefined) {
      // Remove old images
      await BookMedia.destroy({ where: { bookId: id } });

      // Add new images
      const imageArray = Array.isArray(req.body.images) ? req.body.images : [];
      if (imageArray.length > 0) {
        const mediaRecords = imageArray.map((img, index) => ({
          bookId: id,
          imageUrl: img.url,
          thumbnailUrl: img.thumbnail || img.url,
          displayOrder: index,
        }));
        await BookMedia.bulkCreate(mediaRecords);
      }
    }

    // Handle category updates if provided
    if (req.body.categoryIds !== undefined) {
      // Remove old category associations
      await BookCategory.destroy({ where: { bookId: id } });

      // Add new category associations
      const categoryIdArray = Array.isArray(req.body.categoryIds) ? req.body.categoryIds : [];
      if (categoryIdArray.length > 0) {
        const categoryRecords = categoryIdArray.map((categoryId) => ({
          bookId: parseInt(id),
          categoryId: parseInt(categoryId),
        }));
        await BookCategory.bulkCreate(categoryRecords, {
          ignoreDuplicates: true,
        });
      }
    }

    // Fetch updated product with categories
    const updatedProduct = await Book.findByPk(id, {
      include: [
        { model: BookMedia, as: 'media' },
        { model: Category, as: 'categories', through: { attributes: [] } },
      ],
    });

    // Update in Meilisearch (async, don't wait)
    indexBook(id).catch((err) => console.error('Failed to update book in search:', err));

    return res.json({
      success: true,
      message: 'Product updated successfully',
      data: updatedProduct,
    });
  } catch (error) {
    console.error('Error updating product:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update product',
      error: error.message,
    });
  }
};

/**
 * Delete/Archive product
 * DELETE /api/vendor/products/:id
 */
export const deleteProduct = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { id } = req.params;

    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found',
      });
    }

    const product = await Book.findOne({
      where: { id, vendorId: vendor.id },
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Archive instead of hard delete
    await product.update({ status: 'archived' });

    // Remove from Meilisearch (async, don't wait) since archived products shouldn't appear in search
    removeBookFromIndex(id).catch((err) =>
      console.error('Failed to remove book from search:', err),
    );

    return res.json({
      success: true,
      message: 'Product archived successfully',
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete product',
      error: error.message,
    });
  }
};

/**
 * Update product status (publish/draft)
 * PATCH /api/vendor/products/:id/status
 */
export const updateProductStatus = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { id } = req.params;
    const { status } = req.body;

    if (!['draft', 'published', 'archived'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status value',
      });
    }

    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found',
      });
    }

    const product = await Book.findOne({
      where: { id, vendorId: vendor.id },
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    await product.update({ status });

    // Update search index based on status
    if (status === 'archived') {
      // Remove from search if archived
      removeBookFromIndex(id).catch((err) =>
        console.error('Failed to remove book from search:', err),
      );
    } else {
      // Index/update if active or draft
      indexBook(id).catch((err) => console.error('Failed to update book in search:', err));
    }

    return res.json({
      success: true,
      message: 'Product status updated successfully',
      data: product,
    });
  } catch (error) {
    console.error('Error updating product status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update product status',
      error: error.message,
    });
  }
};

/**
 * Update product quantity
 * PATCH /api/vendor/products/:id/quantity
 */
export const updateProductQuantity = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { id } = req.params;
    const { quantity } = req.body;

    if (quantity === undefined || quantity === null || quantity < 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid quantity value',
      });
    }

    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found',
      });
    }

    const product = await Book.findOne({
      where: { id, vendorId: vendor.id },
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    const updates = { quantity };
    if (quantity === 0 && product.status === 'active') {
      updates.status = 'sold';
    } else if (quantity > 0 && product.status === 'sold') {
      updates.status = 'active';
    }

    await product.update(updates);

    return res.json({
      success: true,
      message: 'Product quantity updated successfully',
      data: product,
    });
  } catch (error) {
    console.error('Error updating product quantity:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update product quantity',
      error: error.message,
    });
  }
};

/**
 * Relist a sold/archived product
 * POST /api/vendor/products/:id/relist
 */
export const relistProduct = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { id } = req.params;
    const { quantity } = req.body;

    const vendor = await Vendor.findOne({ where: { userId } });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found',
      });
    }

    const product = await Book.findOne({
      where: { id, vendorId: vendor.id },
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    await product.update({
      status: 'active',
      quantity: quantity || 1,
    });

    indexBook(id).catch((err) => console.error('Failed to index book:', err));

    return res.json({
      success: true,
      message: 'Product relisted successfully',
      data: product,
    });
  } catch (error) {
    console.error('Error relisting product:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to relist product',
      error: error.message,
    });
  }
};
