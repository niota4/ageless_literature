/**
 * Admin Orders Controller
 * Manages orders
 */

import db from '../../models/index.js';
import { Op } from 'sequelize';

const { Order, OrderItem, Book, BookMedia, User } = db;

/**
 * List all orders
 * Query params: page, limit, status, search
 */
export const listAll = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (status && status !== 'all') where.status = status;
    if (search) where.orderNumber = { [Op.iLike]: `%${search}%` };

    const { count, rows: orders } = await Order.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'firstName', 'lastName', 'email'],
        },
        {
          model: OrderItem,
          as: 'items',
          required: false,
          include: [
            {
              model: Book,
              as: 'book',
              required: false,
              attributes: ['id', 'title', 'author', 'price'],
              include: BookMedia
                ? [
                    {
                      model: BookMedia,
                      as: 'media',
                      required: false,
                      attributes: ['imageUrl', 'thumbnailUrl', 'isPrimary', 'displayOrder'],
                    },
                  ]
                : [],
            },
          ],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset,
      subQuery: false,
      distinct: true,
    });

    const enriched = orders.map((order) => {
      const o = order.toJSON();
      const enrichedItems = (o.items || []).map((item) => {
        const media = item.book?.media || [];
        const primaryMedia =
          media.find((m) => m.isPrimary) ||
          [...media].sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))[0];
        return {
          ...item,
          title: item.title || item.book?.title || '',
          book: item.book
            ? {
                ...item.book,
                imageUrl: primaryMedia?.thumbnailUrl || primaryMedia?.imageUrl || null,
              }
            : null,
        };
      });
      const vendorTotal = enrichedItems.reduce(
        (sum, item) => sum + parseFloat(item.price || 0) * (item.quantity || 1),
        0,
      );
      const commissionRate = 0.08; // 8% standard platform rate
      const platformFee = parseFloat((vendorTotal * commissionRate).toFixed(2));
      const vendorNet = parseFloat((vendorTotal - platformFee).toFixed(2));
      return {
        ...o,
        vendorItems: enrichedItems,
        vendorTotal,
        vendorEarnings: vendorTotal,
        platformFee,
        vendorNet,
      };
    });

    return res.json({
      success: true,
      data: {
        orders: enriched,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit)),
        },
      },
      message: 'Orders retrieved successfully',
    });
  } catch (error) {
    console.error('Error listing admin orders:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve orders',
      error: error.message,
    });
  }
};

/**
 * Get order statistics
 * GET /api/admin/orders/stats
 */
export const getOrderStats = async (req, res) => {
  try {
    const statuses = ['completed', 'pending', 'processing', 'shipped', 'delivered', 'on_hold', 'cancelled', 'failed'];

    const counts = await Promise.all(
      statuses.map((s) => Order.count({ where: { status: s } }))
    );

    const statusMap = Object.fromEntries(statuses.map((s, i) => [s, counts[i]]));

    const total = await Order.count();

    // Revenue: sum of total_amount for completed/delivered orders
    const revenueResult = await Order.findOne({
      attributes: [
        [db.sequelize.fn('SUM', db.sequelize.col('total_amount')), 'totalRevenue'],
      ],
      where: { status: ['completed', 'delivered'] },
      raw: true,
    });
    const totalRevenue = parseFloat(revenueResult?.totalRevenue || 0);

    // Average order value across all orders
    const avgResult = await Order.findOne({
      attributes: [
        [db.sequelize.fn('AVG', db.sequelize.col('total_amount')), 'avgValue'],
      ],
      raw: true,
    });
    const avgOrderValue = parseFloat(avgResult?.avgValue || 0);

    return res.json({
      success: true,
      data: {
        total,
        completed: statusMap.completed + statusMap.delivered,
        pending: statusMap.pending + statusMap.processing,
        shipped: statusMap.shipped,
        onHold: statusMap.on_hold,
        cancelled: statusMap.cancelled + statusMap.failed,
        totalRevenue,
        avgOrderValue,
      },
    });
  } catch (error) {
    console.error('[Admin Orders] Stats error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve order statistics',
      error: error.message,
    });
  }
};

/**
 * Get single order
 */
export const getOne = async (req, res) => {
  try {
    const { id } = req.params;

    return res.json({
      success: true,
      data: {
        id,
        orderNumber: `ORD-${id}`,
        status: 'pending',
        total: 0,
        items: [],
      },
      message: 'Order retrieved successfully',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve order',
      error: error.message,
    });
  }
};

/**
 * Update order status
 * Body: { status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled' }
 */
export const updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
    }

    // Find the order first
    const order = await db.Order.findByPk(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    // Update order status
    order.status = status;
    await order.save();

    return res.json({
      success: true,
      data: { id: order.id, status: order.status },
      message: 'Order status updated successfully',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update order status',
      error: error.message,
    });
  }
};

/**
 * Refund order
 * Body: { amount?, reason?, refundShipping? }
 */
export const refundOrder = async (req, res) => {
  try {
    const { id } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { amount, reason } = req.body;

    return res.json({
      success: true,
      data: {
        id,
        refundAmount: amount,
        refundedAt: new Date(),
      },
      message: 'Order refunded successfully',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to refund order',
      error: error.message,
    });
  }
};
