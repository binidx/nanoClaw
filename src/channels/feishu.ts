/**
 * Feishu (飞书/Lark) channel for NanoClaw — barrel re-exports for backward compatibility.
 *
 * Implementation is split across `feishu-*.ts` modules; importing this file preserves
 * existing paths and triggers channel registration via `./feishu-channel.js`.
 */
export * from './feishu-types.js';
export * from './feishu-jid.js';
export * from './feishu-channel.js';
export * from './feishu-members.js';
export * from './feishu-doc.js';
