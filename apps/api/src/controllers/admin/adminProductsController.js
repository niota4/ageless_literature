/**
 * Admin Products Controller
 * Manages both Books and Collectibles/Products from admin panel
 */

import db from '../../models/index.js';
import { Op, Sequelize } from 'sequelize';

const { Book, Product, Vendor, BookMedia, Category, Auction } = db;

// User IDs whose auction wins are treated as "expired" (not real sales)
// dantewilken (user 77) is a test/shill bidder
const EXPIRED_AUCTION_WINNER_IDS = [77];

/**
 * Normalize JSONB description to string
 * Books store description as JSONB {html: "..."}, this extracts the HTML string
 */
const normalizeDescription = (desc) => {
  if (desc && typeof desc === 'object') {
    return desc.html || desc.en || '';
  }
  return desc || '';
};

/**
 * List all products (Books + Collectibles) with filtering, search, and pagination
 * GET /api/admin/products
 */
export const listAll = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      type = '', // 'book' or 'product'
      status = '', // 'published', 'draft', 'archived'
      vendorId = '',
      minPrice = '',
      maxPrice = '',
      sortBy = 'createdAt',
      sortOrder = 'DESC',
      auctionStatus = '', // 'live_auction', 'auction_sold', 'expired_auction'
      excludeAuction = '', // 'true' to exclude books with any auction history
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Build search conditions
    const searchConditions = search
      ? {
          [Op.or]: [
            { title: { [Op.iLike]: `%${search}%` } },
            { author: { [Op.iLike]: `%${search}%` } },
            ...(search.match(/^\d+$/) ? [{ isbn: { [Op.iLike]: `%${search}%` } }] : []),
          ],
        }
      : {};

    // Build filter conditions
    const filterConditions = {};
    if (vendorId) filterConditions.vendorId = vendorId;
    if (status === 'archived') {
      filterConditions.status = 'archived';
    } else if (status && !auctionStatus) {
      filterConditions.status = status;
    } else {
      // Default: exclude archived (covers All tab and auction tabs)
      filterConditions.status = { [Op.ne]: 'archived' };
    }

    // Price range filter
    if (minPrice || maxPrice) {
      filterConditions.price = {};
      if (minPrice) filterConditions.price[Op.gte] = parseFloat(minPrice);
      if (maxPrice) filterConditions.price[Op.lte] = parseFloat(maxPrice);
    }

    const whereClause = {
      ...searchConditions,
      ...filterConditions,
    };

    // Auction-based filtering via subqueries
    const expiredWinnerIds = EXPIRED_AUCTION_WINNER_IDS.join(',');

    if (auctionStatus === 'live_auction') {
      // Books with an active auction
      if (!whereClause[Op.and]) whereClause[Op.and] = [];
      whereClause[Op.and].push(
        Sequelize.literal(`"Book"."id" IN (SELECT book_id FROM auctions WHERE status = 'active' AND book_id IS NOT NULL)`)
      );
    } else if (auctionStatus === 'auction_sold') {
      // Books whose latest auction was won by a real buyer (not shill bidder)
      if (!whereClause[Op.and]) whereClause[Op.and] = [];
      whereClause[Op.and].push(
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
      // Books whose latest auction ended without a real sale
      if (!whereClause[Op.and]) whereClause[Op.and] = [];
      whereClause[Op.and].push(
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
      if (!whereClause[Op.and]) whereClause[Op.and] = [];
      whereClause[Op.and].push(
        Sequelize.literal(`"Book"."id" NOT IN (SELECT book_id FROM auctions WHERE book_id IS NOT NULL)`)
      );
    }

    // Determine order - map camelCase/snake_case to Sequelize attribute names
    const sortByMap = {
      menuOrder: 'menuOrder',
      menu_order: 'menuOrder',
      title: 'title',
      price: 'price',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    };
    const safeSortBy = sortByMap[sortBy] || 'createdAt';
    const orderClause = [[safeSortBy, sortOrder]];

    // Fetch data based on type filter
    let products = [];
    let totalCount = 0;

    if (!type || type === 'book') {
      // Always use DB-level pagination for books (13K+ rows)
      const books = await Book.findAll({
        where: whereClause,
        include: [
          {
            model: Vendor,
            as: 'vendor',
            attributes: ['id', 'shopName', 'shopUrl'],
          },
        ],
        order: orderClause,
        limit: parseInt(limit),
        offset,
      });

      const booksCount = await Book.count({ where: whereClause });

      // Fetch book media for all books
      const bookIds = books.map((b) => b.id);
      let bookMediaMap = {};

      if (bookIds.length > 0) {
        const allMedia = await BookMedia.findAll({
          where: {
            bookId: { [Op.in]: bookIds },
          },
          order: [['displayOrder', 'ASC']],
        });

        // Group media by bookId
        bookMediaMap = allMedia.reduce((acc, media) => {
          if (!acc[media.bookId]) acc[media.bookId] = [];
          acc[media.bookId].push({
            url: media.imageUrl,
            imageUrl: media.imageUrl,
            thumbnailUrl: media.thumbnailUrl,
            displayOrder: media.displayOrder,
            isPrimary: media.isPrimary,
          });
          return acc;
        }, {});
      }

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

      products = books.map((book) => ({
        id: book.id,
        title: book.title,
        type: 'book',
        price: parseFloat(book.price || 0),
        description: book.description?.html || book.shortDescription || '',
        shortDescription: book.shortDescription || '',
        vendor: book.vendor
          ? {
              id: book.vendor.id,
              shopName: book.vendor.shopName,
              shopUrl: book.vendor.shopUrl,
            }
          : null,
        status: book.status,
        condition: book.condition,
        category: book.category,
        author: book.author,
        isbn: book.isbn,
        menuOrder: book.menuOrder || 0,
        images: bookMediaMap[book.id] || [],
        auction: auctionMap[book.id] || null,
        createdAt: book.createdAt,
        updatedAt: book.updatedAt,
      }));

      totalCount = booksCount;
    }

    if (type === 'product') {
      // Build product-specific search
      const productSearchConditions = search
        ? {
            [Op.or]: [
              { title: { [Op.iLike]: `%${search}%` } },
              { sku: { [Op.iLike]: `%${search}%` } },
            ],
          }
        : {};

      const productWhereClause = {
        ...productSearchConditions,
        ...filterConditions,
      };

      if (status) {
        productWhereClause.status = status;
      }

      const collectibles = await Product.findAll({
        where: productWhereClause,
        include: [
          {
            model: Vendor,
            as: 'vendor',
            attributes: ['id', 'shopName', 'shopUrl'],
          },
        ],
        order: orderClause,
        limit: parseInt(limit),
        offset,
      });

      const productsCount = await Product.count({ where: productWhereClause });

      const mappedProducts = collectibles.map((prod) => ({
        id: prod.id,
        title: prod.title,
        type: 'product',
        price: parseFloat(prod.price || 0),
        vendor: prod.vendor
          ? {
              id: prod.vendor.id,
              shopName: prod.vendor.shopName,
              shopUrl: prod.vendor.shopUrl,
            }
          : null,
        status: prod.status || 'draft',
        condition: prod.condition,
        category: prod.category,
        sku: prod.sku,
        quantity: prod.quantity,
        menuOrder: prod.menuOrder || 0,
        images: prod.images || [],
        createdAt: prod.createdAt,
        updatedAt: prod.updatedAt,
      }));

      products = mappedProducts;
      totalCount = productsCount;
    }

    const totalPages = Math.ceil(totalCount / parseInt(limit));

    res.json({
      success: true,
      data: products,
      pagination: {
        total: totalCount,
        totalPages,
        currentPage: parseInt(page),
        perPage: parseInt(limit),
        hasNextPage: parseInt(page) < totalPages,
        hasPrevPage: parseInt(page) > 1,
      },
    });
  } catch (error) {
    console.error('[Admin Products] List error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: error.message,
    });
  }
};

/**
 * Create a new product (Book or Collectible)
 * POST /api/admin/products
 */
export const createProduct = async (req, res) => {
  try {
    const { type, ...productData } = req.body;

    if (!type || !['book', 'product'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Valid product type (book or product) is required',
      });
    }

    let newProduct = null;

    if (type === 'book') {
      // Validate required book fields
      if (!productData.title || !productData.price) {
        return res.status(400).json({
          success: false,
          message: 'Title and price are required for books',
        });
      }

      // Create book
      const price = parseFloat(productData.price);
      const status = price === 0 ? 'draft' : productData.status || 'published';

      newProduct = await Book.create({
        title: productData.title,
        author: productData.author || '',
        isbn: productData.isbn || null,
        price: price,
        status: status,
        condition: productData.condition || 'Good',
        category: productData.category || '',
        description:
          typeof productData.description === 'string'
            ? { html: productData.description }
            : productData.description || { html: '' },
        shortDescription: productData.shortDescription || null,
        quantity: parseInt(productData.quantity) || 1,
        vendorId: productData.vendorId || null,
        menuOrder: parseInt(productData.menuOrder) || 0,
      });

      // Handle image uploads if provided
      if (productData.images && productData.images.length > 0) {
        const mediaRecords = productData.images.map((img, index) => ({
          bookId: newProduct.id,
          imageUrl: img.url,
          thumbnailUrl: img.thumbnail || img.url,
          displayOrder: index,
        }));
        await BookMedia.bulkCreate(mediaRecords);
      }

      // Handle category associations
      if (productData.categoryIds && productData.categoryIds.length > 0) {
        await newProduct.setCategories(productData.categoryIds);
      }

      // Fetch complete book with media and categories
      const completeBook = await Book.findByPk(newProduct.id, {
        include: [
          { model: BookMedia, as: 'media' },
          {
            model: Category,
            as: 'categories',
            through: { attributes: [] },
          },
        ],
      });

      const message =
        status === 'draft' && price === 0
          ? 'Book created as draft. Set a price above $0 to publish.'
          : 'Book created successfully';

      return res.status(201).json({
        success: true,
        message: message,
        warning:
          status === 'draft' && price === 0
            ? 'This book will remain in draft status until a price is set.'
            : null,
        data: {
          id: completeBook.id,
          type: 'book',
          ...completeBook.toJSON(),
          images:
            completeBook.media?.map((m) => ({
              url: m.imageUrl,
              thumbnail: m.thumbnailUrl,
              publicId: m.imageUrl.split('/').pop()?.split('.')[0] || '',
            })) || [],
        },
      });
    }

    if (type === 'product') {
      // Validate required product fields
      if (!productData.title || !productData.price) {
        return res.status(400).json({
          success: false,
          message: 'Title and price are required for products',
        });
      }

      // Create product
      newProduct = await Product.create({
        title: productData.title,
        price: parseFloat(productData.price),
        salePrice: productData.salePrice ? parseFloat(productData.salePrice) : null,
        quantity: parseInt(productData.quantity) || 1,
        condition: productData.condition || 'Good',
        conditionNotes: productData.conditionNotes || '',
        category: productData.category || '',
        description: productData.description || '',
        shortDescription: productData.shortDescription || null,
        sku: productData.sku || null,
        artist: productData.artist || '',
        yearMade: productData.yearMade || null,
        origin: productData.origin || '',
        materials: productData.materials || '',
        dimensions: productData.dimensions || '',
        weight: productData.weight || null,
        isSigned: productData.isSigned || false,
        isAuthenticated: productData.isAuthenticated || false,
        tags: productData.tags || [],
        images: productData.images || [],
        status: productData.status || 'draft',
        vendorId: productData.vendorId || null,
      });

      // Handle category associations
      if (productData.categoryIds && productData.categoryIds.length > 0) {
        await newProduct.setCategories(productData.categoryIds);
      }

      // Fetch complete product with categories
      const completeProduct = await Product.findByPk(newProduct.id, {
        include: [
          {
            model: Category,
            as: 'categories',
            through: { attributes: [] },
          },
        ],
      });

      return res.status(201).json({
        success: true,
        message: 'Product created successfully',
        data: {
          id: completeProduct.id,
          type: 'product',
          ...completeProduct.toJSON(),
        },
      });
    }

    res.status(400).json({
      success: false,
      message: 'Invalid product type',
    });
  } catch (error) {
    console.error('[Admin Products] Create error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create product',
      error: error.message,
    });
  }
};

/**
 * Get single product (Book or Collectible) by ID
 * GET /api/admin/products/:id
 */
export const getProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { type } = req.query; // 'book' or 'product'

    let product = null;

    if (!type || type === 'book') {
      product = await Book.findByPk(id, {
        include: [
          {
            model: Vendor,
            as: 'vendor',
            attributes: ['id', 'shopName', 'shopUrl', 'logoUrl'],
          },
          {
            model: Category,
            as: 'categories',
            through: { attributes: [] },
          },
        ],
      });

      if (product) {
        // Fetch book images from book_media
        const media = await BookMedia.findAll({
          where: { bookId: id },
          order: [['displayOrder', 'ASC']],
        });

        return res.json({
          success: true,
          data: {
            id: product.id,
            title: product.title,
            type: 'book',
            author: product.author,
            isbn: product.isbn,
            price: parseFloat(product.price || 0),
            quantity: product.quantity,
            condition: product.condition,
            category: product.category,
            description: normalizeDescription(product.description),
            shortDescription: product.shortDescription,
            vendor: product.vendor
              ? {
                  id: product.vendor.id,
                  shopName: product.vendor.shopName,
                  shopUrl: product.vendor.shopUrl,
                  logoUrl: product.vendor.logoUrl,
                }
              : null,
            vendorId: product.vendorId,
            status: product.status,
            menuOrder: product.menuOrder || 0,
            categories: product.categories || [],
            images: media.map((m) => ({
              url: m.imageUrl,
              thumbnail: m.thumbnailUrl,
              publicId: m.imageUrl.split('/').pop()?.split('.')[0] || '',
            })),
            createdAt: product.createdAt,
            updatedAt: product.updatedAt,
          },
        });
      }
    }

    if (!type || type === 'product') {
      product = await Product.findByPk(id, {
        include: [
          {
            model: Vendor,
            as: 'vendor',
            attributes: ['id', 'shopName', 'shopUrl', 'logoUrl'],
          },
        ],
      });

      if (product) {
        return res.json({
          success: true,
          data: {
            id: product.id,
            title: product.title,
            type: 'product',
            price: parseFloat(product.price || 0),
            quantity: product.quantity,
            condition: product.condition,
            category: product.category,
            description: normalizeDescription(product.description),
            shortDescription: product.shortDescription,
            sku: product.sku,
            artist: product.artist,
            yearMade: product.yearMade,
            materials: product.materials,
            dimensions: product.dimensions,
            weight: product.weight,
            isSigned: product.isSigned,
            isAuthenticated: product.isAuthenticated,
            tags: product.tags,
            vendor: product.vendor
              ? {
                  id: product.vendor.id,
                  shopName: product.vendor.shopName,
                  shopUrl: product.vendor.shopUrl,
                  logoUrl: product.vendor.logoUrl,
                }
              : null,
            vendorId: product.vendorId,
            status: product.status || 'draft',
            images: product.images || [],
            createdAt: product.createdAt,
            updatedAt: product.updatedAt,
          },
        });
      }
    }

    res.status(404).json({
      success: false,
      message: 'Product not found',
    });
  } catch (error) {
    console.error('[Admin Products] Get product error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product',
      error: error.message,
    });
  }
};

/**
 * Update product (Book or Collectible)
 * PUT /api/admin/products/:id
 */
export const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { type: bodyType, ...updates } = req.body;
    const type = bodyType || req.query.type;

    let product = null;

    if (type === 'book') {
      product = await Book.findByPk(id);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Book not found',
        });
      }

      // Update allowed fields
      const allowedFields = [
        'title',
        'author',
        'isbn',
        'price',
        'quantity',
        'condition',
        'category',
        'description',
        'shortDescription',
        'vendorId',
        'status',
        'menuOrder',
      ];

      let autoDrafted = false;

      allowedFields.forEach((field) => {
        if (updates[field] !== undefined) {
          if (field === 'price') {
            const newPrice = parseFloat(updates[field]);
            product[field] = newPrice;
            // Auto-draft if price is set to 0
            if (newPrice === 0) {
              product.status = 'draft';
              autoDrafted = true;
            } else if (product.status === 'draft' && updates.status === undefined) {
              // If price is set above 0 and currently draft, suggest publishing
              // but don't auto-publish (let user decide)
            }
          } else if (field === 'description') {
            // Convert plain text to JSONB format for description field
            const value = updates[field];
            if (typeof value === 'string') {
              product[field] = { html: value };
            } else {
              product[field] = value;
            }
          } else if (field === 'shortDescription') {
            // shortDescription is TEXT, not JSONB - keep as string
            product[field] = updates[field];
          } else {
            product[field] = updates[field];
          }
        }
      });

      await product.save();

      // Handle image updates if provided
      if (updates.images) {
        // Remove old images
        await BookMedia.destroy({ where: { bookId: id } });

        // Add new images
        if (updates.images.length > 0) {
          const mediaRecords = updates.images.map((img, index) => ({
            bookId: id,
            imageUrl: img.url,
            thumbnailUrl: img.thumbnail || img.url,
            displayOrder: index,
          }));
          await BookMedia.bulkCreate(mediaRecords);
        }
      }

      // Handle category associations
      if (updates.categoryIds !== undefined) {
        await product.setCategories(updates.categoryIds);
      }

      // Fetch updated book with media and categories
      const updatedProduct = await Book.findByPk(id, {
        include: [
          { model: BookMedia, as: 'media' },
          {
            model: Category,
            as: 'categories',
            through: { attributes: [] },
          },
        ],
      });

      const message = autoDrafted
        ? 'Book updated and set to draft due to $0 price. Set a price above $0 to publish.'
        : 'Book updated successfully';

      return res.json({
        success: true,
        message: message,
        warning: autoDrafted ? 'This book will remain in draft status until a price is set.' : null,
        data: {
          ...updatedProduct.toJSON(),
          images:
            updatedProduct.media?.map((m) => ({
              url: m.imageUrl,
              thumbnail: m.thumbnailUrl,
              publicId: m.imageUrl.split('/').pop()?.split('.')[0] || '',
            })) || [],
        },
      });
    }

    if (type === 'product') {
      product = await Product.findByPk(id);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found',
        });
      }

      // Update allowed fields
      const allowedFields = [
        'title',
        'price',
        'quantity',
        'condition',
        'category',
        'description',
        'shortDescription',
        'sku',
        'artist',
        'yearMade',
        'materials',
        'dimensions',
        'weight',
        'isSigned',
        'isAuthenticated',
        'tags',
        'images',
        'status',
        'vendorId',
      ];

      allowedFields.forEach((field) => {
        if (updates[field] !== undefined) {
          product[field] = updates[field];
        }
      });

      await product.save();

      // Handle category associations
      if (updates.categoryIds !== undefined) {
        await product.setCategories(updates.categoryIds);
      }

      // Fetch complete product with categories
      const updatedProduct = await Product.findByPk(id, {
        include: [
          {
            model: Category,
            as: 'categories',
            through: { attributes: [] },
          },
        ],
      });

      return res.json({
        success: true,
        message: 'Product updated successfully',
        data: updatedProduct,
      });
    }

    res.status(400).json({
      success: false,
      message: 'Invalid product type',
    });
  } catch (error) {
    console.error('[Admin Products] Update error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update product',
      error: error.message,
    });
  }
};

/**
 * Delete/Archive product
 * DELETE /api/admin/products/:id
 */
export const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { type, hardDelete = false } = req.query;

    let product = null;

    if (type === 'book') {
      product = await Book.findByPk(id);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Book not found',
        });
      }

      if (hardDelete === 'true') {
        await product.destroy();
      } else {
        // Soft delete - just mark as inactive
        product.quantity = 0;
        await product.save();
      }

      return res.json({
        success: true,
        message: hardDelete === 'true' ? 'Book deleted successfully' : 'Book archived successfully',
      });
    }

    if (type === 'product') {
      product = await Product.findByPk(id);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found',
        });
      }

      if (hardDelete === 'true') {
        await product.destroy();
      } else {
        // Soft delete - set to archived
        product.status = 'archived';
        await product.save();
      }

      return res.json({
        success: true,
        message:
          hardDelete === 'true' ? 'Product deleted successfully' : 'Product archived successfully',
      });
    }

    res.status(400).json({
      success: false,
      message: 'Invalid product type',
    });
  } catch (error) {
    console.error('[Admin Products] Delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete product',
      error: error.message,
    });
  }
};

/**
 * Get product statistics
 * GET /api/admin/products/stats
 */
export const getProductStats = async (req, res) => {
  try {
    const bookCount = await Book.count();
    const productCount = await Product.count({
      where: {
        status: { [Op.ne]: 'archived' },
      },
    });

    // Calculate total value
    const bookTotal = (await Book.sum('price')) || 0;
    const productTotal =
      (await Product.sum('price', {
        where: { status: 'published' },
      })) || 0;
    const totalValue = parseFloat(bookTotal) + parseFloat(productTotal);

    res.json({
      success: true,
      data: {
        totalBooks: bookCount,
        totalProducts: productCount,
        totalItems: bookCount + productCount,
        totalValue,
      },
    });
  } catch (error) {
    console.error('[Admin Products] Stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product stats',
      error: error.message,
    });
  }
};
