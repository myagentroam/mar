export class MarctlError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'MarctlError';
    this.code = options.code;
    this.requestId = options.requestId;
    this.upstreamRequestId = options.upstreamRequestId;
    this.details = options.details;
    this.statusCode = options.statusCode;
  }
}
