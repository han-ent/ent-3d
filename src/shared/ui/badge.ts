import type { ReviewStatus } from '../types';

export function statusBadge(status: ReviewStatus): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = status === 'YS 검수 완료' ? 'badge badge-verified' : 'badge badge-unverified';
  el.textContent = status;
  el.dataset.status = status;
  return el;
}
