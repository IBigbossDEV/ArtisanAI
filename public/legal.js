// يعبّي بيانات المنشأة في الصفحة، وإذا المالك كتب نص بديل من لوحته يعرضه بدل النص الافتراضي
(function () {
  const S = window.SITE || {};
  document.querySelectorAll('[data-site]').forEach((el) => {
    const k = el.dataset.site;
    if (k === 'email' && S.email && !S.email.startsWith('[')) { el.innerHTML = `<a href="mailto:${S.email}">${S.email}</a>`; return; }
    if (k === 'whatsapp') {
      if (!S.whatsapp) { const row = el.closest('[data-optional]'); if (row) row.remove(); return; }
      el.innerHTML = `<a href="https://wa.me/${S.whatsapp}" target="_blank" rel="noopener">+${S.whatsapp}</a>`; return;
    }
    if (k === 'vatNo' && !S.vatNo) { const row = el.closest('[data-optional]'); if (row) row.remove(); return; }
    el.textContent = S[k] || '';
  });
  const slug = document.body.dataset.slug;
  if (!slug) return;
  fetch('/api/page?slug=' + slug).then((r) => r.json()).then(({ text }) => {
    if (!text || !text.trim()) return;
    const box = document.getElementById('content'); if (!box) return;
    const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    box.innerHTML = text.trim().split(/\n{2,}/).map((block) => {
      const b = block.trim();
      if (b.startsWith('## ')) return `<h2>${esc(b.slice(3))}</h2>`;
      if (b.split('\n').every((l) => /^[-•]\s/.test(l.trim()))) return '<ul>' + b.split('\n').map((l) => `<li>${esc(l.trim().slice(2))}</li>`).join('') + '</ul>';
      return `<p>${esc(b).replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }).catch(() => {});
})();
