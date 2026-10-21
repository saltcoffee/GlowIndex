/** 业务错误：带 HTTP 状态码和机器可读 code。 */
export class ApiError extends Error {
  constructor(status, code, message, hint = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}
