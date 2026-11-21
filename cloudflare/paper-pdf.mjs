const encoder = new TextEncoder();

// All page images are full-size RGB JPEGs. Embed their original bytes in the PDF.
export async function paperPdf(pages, readImage) {
  const chunks = [],
    offsets = [0];
  let length = 0;
  function append(value) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    chunks.push(bytes);
    length += bytes.length;
  }
  function start(id) {
    offsets[id] = length;
    append(id + ' 0 obj\n');
  }
  append('%PDF-1.4\n');
  start(1);
  append('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  start(2);
  append(
    '<< /Type /Pages /Count ' +
      pages.length +
      ' /Kids [' +
      pages.map((_, i) => 3 + i * 3 + ' 0 R').join(' ') +
      '] >>\nendobj\n',
  );
  for (const [i, p] of pages.entries()) {
    const id = 3 + i * 3,
      w = p.width >= p.height ? 842 : 595;
    const h = Number(((w * p.height) / p.width).toFixed(3));
    if (p.missing) {
      const message = 'Original page unavailable - ' + p.part + ' / ' + p.number;
      start(id);
      append(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>\nendobj\n`,
      );
      start(id + 1);
      append('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
      const paint = `BT /F 18 Tf 48 ${h - 80} Td (${message}) Tj ET\n`;
      start(id + 2);
      append(`<< /Length ${paint.length} >>\nstream\n${paint}endstream\nendobj\n`);
      continue;
    }
    start(id);
    append(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /PageImage ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>\nendobj\n`,
    );
    const data = new Uint8Array(await readImage(p));
    start(id + 1);
    append(
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n`,
    );
    append(data);
    append('\nendstream\nendobj\n');
    const paint = `q ${w} 0 0 ${h} 0 0 cm /PageImage Do Q\n`;
    start(id + 2);
    append(`<< /Length ${paint.length} >>\nstream\n${paint}endstream\nendobj\n`);
  }
  const xref = length;
  append('xref\n0 ' + offsets.length + '\n0000000000 65535 f \n');
  for (const offset of offsets.slice(1)) append(String(offset).padStart(10, '0') + ' 00000 n \n');
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

export function jpegSize(bytes) {
  if (bytes[0] !== 255 || bytes[1] !== 216) return null;
  let i = 2;
  while (i + 8 < bytes.length && bytes[i] === 255) {
    const type = bytes[i + 1],
      length = bytes[i + 2] * 256 + bytes[i + 3];
    if (type === 192 || type === 194)
      return bytes[i + 9] === 3
        ? { width: bytes[i + 7] * 256 + bytes[i + 8], height: bytes[i + 5] * 256 + bytes[i + 6] }
        : null;
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}
