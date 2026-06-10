/** ActionRouter 统一错误码。客户端可据此做 switch/case 程序化处理。 */
export const ErrorCodes = {
  MISSING_ACTION: 'MISSING_ACTION',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  MISSING_REQUIRED_PARAM: 'MISSING_REQUIRED_PARAM',
  HANDLER_ERROR: 'HANDLER_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];