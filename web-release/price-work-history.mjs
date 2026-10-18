const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => new Intl.NumberFormat('en-GB', {style:'currency',currency:'GBP'}).format(value/100);
const status = value => ({submitted:'Awaiting office approval',approved:'Approved by office',rejected:'Rejected by office',withdrawn:'Withdrawn'}[value] ?? value);

export function priceWorkHistory(item) {
  const claims = [...(item.claims ?? [])].sort((a,b) => b.submittedAt.localeCompare(a.submittedAt));
  return `<p class="muted">Claimed to date: ${money(item.claimedToDatePence)} · Awaiting approval: ${money(item.pendingPence)}</p>${claims.length ? `<section aria-label="${esc('Your claim history for '+item.workItem)}"><h4>Your claim history</h4>${claims.map(claim => `<p>${esc(claim.workDate)} · ${money(claim.amountPence)} · ${esc(status(claim.status))}${claim.reason ? `<br>Office reason: ${esc(claim.reason)}` : ''}</p>`).join('')}</section>` : ''}`;
}
