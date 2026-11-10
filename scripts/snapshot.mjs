// يجلب نسخة جاهزة من كل صفحة (HTML عام فقط، بلا أي بيانات طلاب) لتسريع أول فتح للموقع.
import { writeFile, readFile, mkdir } from 'node:fs/promises';

const EXEC = 'https://script.google.com/macros/s/AKfycbzpDJKLle8sT7AyxX_EhFNbRkYm2aE4Ztd3dToGb_qaZZwX4YtNMEBc5xBAR5M7aq4r/exec';
const PAGES = ['', 'admin', 'register', 'result', 'dataentry', 'direct', 'summary', 'rewards',
  'deliveries', 'certificates', 'visits', 'executive', 'schedule'];

await mkdir('app/pages', { recursive: true });
let changed = 0, failed = 0;
for (const page of PAGES) {
  const name = page || 'home';
  try {
    const res = await fetch(EXEC, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'apppage', params: page ? { page } : {} }),
      redirect: 'follow'
    });
    const d = await res.json();
    if (!d || !d.ok || typeof d.html !== 'string' || d.html.length < 1000) throw new Error('bad response');
    const out = JSON.stringify({ html: d.html, title: d.title || '' });
    const file = `app/pages/${name}.json`;
    let old = '';
    try { old = await readFile(file, 'utf8'); } catch {}
    if (old !== out) { await writeFile(file, out); changed++; }
    console.log(`${name}: ok ${d.html.length}`);
  } catch (e) {
    failed++;
    console.log(`${name}: FAILED ${e.message}`);
  }
}
console.log(`changed=${changed} failed=${failed}`);
