import { logError } from '../logger.js';

const STATUS_LABELS = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable entity',
  429: 'Too many requests',
  500: 'Internal server error',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Gateway timeout'
};

function pickLabel(status) {
  return STATUS_LABELS[status] || 'Error';
}

function ensureError(errorLike) {
  if (errorLike instanceof Error) {
    return errorLike;
  }
  if (typeof errorLike === 'string') {
    return new Error(errorLike);
  }
  try {
    return new Error(JSON.stringify(errorLike));
  } catch (e) {
    return new Error('未知错误');
  }
}

/**
 * 标准错误响应构造器
 */
export function errorResponse(status, error, message) {
  return {
    status,
    body: {
      error,
      message
    }
  };
}

/**
 * 成功响应构造器
 */
export function successResponse(data, message = null) {
  const response = {
    success: true
  };

  if (message) {
    response.message = message;
  }

  if (data !== undefined) {
    response.data = data;
  }

  return response;
}

/**
 * 处理常见错误并返回对应的HTTP响应
 * 根据error.message自动判断错误类型
 */
export function handleCommonError(error, operation) {
  const normalized = ensureError(error);
  const status = typeof normalized.statusCode === 'number'
    ? normalized.statusCode
    : typeof normalized.status === 'number'
      ? normalized.status
      : 500;

  const message = normalized.message || '服务器冒烟了，但我们已经在修。';

  logError(`Failed to ${operation}`, normalized);

  return errorResponse(status, pickLabel(status), message);
}

/**
 * 发送错误响应的便捷函数
 */
export function sendErrorResponse(res, errorOrStatus, operationOrMessage, maybeDetails) {
  if (typeof errorOrStatus === 'number') {
    const status = errorOrStatus;
    const messageSource = operationOrMessage;
    const details = maybeDetails !== undefined ? maybeDetails : (
      messageSource && typeof messageSource === 'object' && !(messageSource instanceof Error)
        ? messageSource
        : undefined
    );

    const message = typeof messageSource === 'string'
      ? messageSource
      : messageSource instanceof Error
        ? messageSource.message
        : '请求处理失败';

    const payload = {
      error: pickLabel(status),
      message
    };

    if (details && details !== message) {
      payload.details = details;
    }

    if (status >= 500) {
      logError(`Admin API responded with ${status}`, ensureError(messageSource));
    }

    return res.status(status).json(payload);
  }

  const operation = typeof operationOrMessage === 'string' ? operationOrMessage : 'process request';
  const normalizedError = ensureError(errorOrStatus);
  const { status, body } = handleCommonError(normalizedError, operation);
  return res.status(status).json(body);
}

/**
 * 发送成功响应的便捷函数
 */
export function sendSuccessResponse(res, data, message = null) {
  return res.json(successResponse(data, message));
}

/**
 * 参数校验错误响应（400 Bad Request）
 */
export function sendBadRequest(res, message) {
  return res.status(400).json({
    error: 'Bad request',
    message
  });
}

/**
 * 包装异步路由处理函数，自动捕获错误并处理
 * 使用方式：router.get('/path', wrapAsync(async (req, res) => { ... }))
 */
export function wrapAsync(handler, operation = 'process request') {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      sendErrorResponse(res, error, operation);
    }
  };
}

/**
 * 包装同步路由处理函数，自动捕获错误并处理
 */
export function wrapSync(handler, operation = 'process request') {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (error) {
      sendErrorResponse(res, error, operation);
    }
  };
}
