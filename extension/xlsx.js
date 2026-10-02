/**
 * xlsx.js — writer XLSX minimale, senza dipendenze.
 *
 * Perché non una libreria: Manifest V3 vieta il codice remoto e un bundle di
 * terze parti pesa molto per un'esigenza semplice (tabelle di testo/numeri).
 * Un .xlsx è uno ZIP di file XML: qui si scrive uno ZIP "stored" (senza
 * compressione) con il minimo OOXML richiesto da Excel/LibreOffice/Sheets.
 *
 * API:  SSXlsx.buildXlsx([{ name, columns:[{key,label,link?,number?}], rows:[{...}] }]) → Uint8Array
 *   - intestazione in grassetto, riga bloccata, filtro automatico, larghezze colonna
 *   - colonne `link`: cella cliccabile (formula HYPERLINK)
 *   - colonne `number`: valore numerico (celle vuote se null)
 */
(function (root) {
  const enc = new TextEncoder();

  // ---------- CRC32 ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- ZIP (stored) ----------
  /** @param {{name:string, data:Uint8Array}[]} files */
  function zip(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const DOS_TIME = 0, DOS_DATE = (46 << 9) | (1 << 5) | 1; // 2026-01-01 (valore fisso, irrilevante)

    const u16 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
    const u32 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
    const cat = (...parts) => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      parts.forEach((p) => { out.set(p, o); o += p.length; });
      return out;
    };

    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const header = cat(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(DOS_TIME), u16(DOS_DATE),
        u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), name
      );
      chunks.push(header, f.data);
      central.push(cat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(DOS_TIME), u16(DOS_DATE),
        u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), name
      ));
      offset += header.length + f.data.length;
    }
    const cd = cat(...central);
    const end = cat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0));
    return cat(...chunks, cd, end);
  }

  // ---------- XML helpers ----------
  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const MAX_CELL = 32767;

  /** Toglie i caratteri di controllo non ammessi in XML 1.0 e fa l'escape. */
  const esc = (s) => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** 0 → A, 25 → Z, 26 → AA */
  function colLetter(i) {
    let s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  const safeSheetName = (n, i) => (String(n || 'Foglio' + (i + 1)).replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31)) || 'Foglio' + (i + 1);

  // Stili: 0 normale, 1 intestazione (grassetto + sfondo), 2 link
  const STYLES = XML_HEAD +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE8F9F9"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  function sheetXml({ columns, rows }) {
    const width = columns.map((c) => {
      const longest = Math.max(String(c.label).length, ...rows.map((r) => String(r[c.key] ?? '').length));
      return Math.min(60, Math.max(8, longest + 2));
    });

    const strCell = (ref, text, style) =>
      `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(String(text).slice(0, MAX_CELL))}</t></is></c>`;

    let xml = XML_HEAD + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<cols>' + width.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols><sheetData>';

    xml += '<row r="1">' + columns.map((c, i) => strCell(colLetter(i) + '1', c.label, 1)).join('') + '</row>';

    rows.forEach((r, ri) => {
      const rn = ri + 2;
      xml += `<row r="${rn}">`;
      columns.forEach((c, ci) => {
        const ref = colLetter(ci) + rn;
        const v = r[c.key];
        if (v === null || v === undefined || v === '') return; // cella vuota
        if (c.number && typeof v === 'number' && isFinite(v)) xml += `<c r="${ref}"><v>${v}</v></c>`;
        else if (c.link && /^https?:\/\//i.test(v) && v.length <= 250) {
          // i letterali stringa nelle formule Excel sono limitati a 255 caratteri
          const u = esc(String(v).replace(/"/g, '""'));
          xml += `<c r="${ref}" t="str" s="2"><f>HYPERLINK("${u}","${u}")</f><v>${esc(v)}</v></c>`;
        } else xml += strCell(ref, v);
      });
      xml += '</row>';
    });

    xml += '</sheetData>';
    if (rows.length) xml += `<autoFilter ref="A1:${colLetter(columns.length - 1)}${rows.length + 1}"/>`;
    return xml + '</worksheet>';
  }

  /** @returns {Uint8Array} contenuto del file .xlsx */
  function buildXlsx(sheets) {
    if (!sheets.length) throw new Error('Nessun foglio da esportare');
    const names = sheets.map((s, i) => safeSheetName(s.name, i));
    const n = sheets.length;
    const idx = (k) => Array.from({ length: n }, (_, i) => k(i + 1)).join('');

    const files = [
      ['[Content_Types].xml', XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        idx((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`) +
        '</Types>'],
      ['_rels/.rels', XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', XML_HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        names.map((nm, i) => `<sheet name="${esc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        idx((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`) +
        `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', STYLES],
      ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)])
    ];
    return zip(files.map(([name, text]) => ({ name, data: enc.encode(text) })));
  }

  const api = { buildXlsx, crc32, colLetter };
  root.SSXlsx = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
