/**
 * OneCLI approval handler — removed in v2.0.33.
 *
 * OneCLI was the credential-injection proxy. Credentials are now injected
 * directly from ~/.clawbridge/.env by container-runner.ts. This file is kept
 * as a stub so imports in response-handler.ts and index.ts compile without
 * changes.
 *
 * The `ONECLI_ACTION` constant is retained so any existing `pending_approvals`
 * rows with action='onecli_credential' are still handled gracefully (dropped).
 */

import { log } from '../../log.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';

export const ONECLI_ACTION = 'onecli_credential';

/** No-op: OneCLI approval system removed. Always returns false. */
export function resolveOneCLIApproval(_approvalId: string, _selectedOption: string): boolean {
  return false;
}

/** No-op: OneCLI approval handler removed in v2.0.33. */
export function startOneCLIApprovalHandler(_deliveryAdapter: ChannelDeliveryAdapter): void {
  log.debug('OneCLI approval handler skipped — removed in v2.0.33');
}

/** No-op: OneCLI approval handler removed in v2.0.33. */
export function stopOneCLIApprovalHandler(): void {
  // nothing to stop
}
