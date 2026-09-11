/**
 * 在浏览器里直接提取 Office Open XML 文档（docx / xlsx / pptx）的文本。
 *
 * 这三类文件本质是 ZIP 包加若干 XML 部件，用浏览器内建的
 * `DecompressionStream('deflate-raw')` 就能解压，不需要引入任何依赖。
 * 提取结果是纯文本，会作为文本附件内联进提示词。
 */

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const MAX_EOCD_SEARCH = 66_000;

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
};

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    // &amp; 必须最后解码，否则会把 &amp;lt; 误解成标签。
    .replace(/&amp;/g, '&');
}

function collapse(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readCentralDirectory(bytes: Uint8Array, view: DataView): ZipEntry[] {
  const total = view.byteLength;
  if (total < 22) throw new Error('文件过小，不是有效的压缩包');

  let eocd = -1;
  const floor = Math.max(0, total - MAX_EOCD_SEARCH);
  for (let i = total - 22; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === ZIP_EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('未找到压缩包目录');

  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const nameDecoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (pointer + 46 > total) break;
    if (view.getUint32(pointer, true) !== ZIP_CENTRAL_SIGNATURE) break;

    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const offset = view.getUint32(pointer + 42, true);

    const name = nameDecoder.decode(
      bytes.subarray(pointer + 46, pointer + 46 + nameLength),
    );
    entries.push({ name, method, compressedSize, offset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflateRaw(raw: Uint8Array): Promise<Uint8Array> {
  // 取出这一段自己的 ArrayBuffer，避免把整个文件的字节一起交给解压流。
  const buffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  ) as ArrayBuffer;
  const stream = new Blob([buffer]).stream().pipeThrough(
    new DecompressionStream('deflate-raw'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(
  bytes: Uint8Array,
  view: DataView,
  entry: ZipEntry,
): Promise<string> {
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const raw = bytes.subarray(start, start + entry.compressedSize);

  const data =
    entry.method === 0
      ? raw
      : entry.method === 8
        ? await inflateRaw(raw)
        : null;
  if (!data) throw new Error(`不支持的压缩方式：${entry.method}`);

  return new TextDecoder('utf-8').decode(data);
}

/** 只需要若干部件的文档，按名取用即可。 */
async function openParts(
  buffer: ArrayBuffer,
  isWanted: (name: string) => boolean,
): Promise<Map<string, string>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const entries = readCentralDirectory(bytes, view).filter((entry) =>
    isWanted(entry.name),
  );

  const parts = new Map<string, string>();
  for (const entry of entries) {
    parts.set(entry.name, await readEntry(bytes, view, entry));
  }
  return parts;
}

function docxToText(documentXml: string): string {
  return collapse(
    documentXml
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]*>/g, ''),
  ).replace(/\t+\n/g, '\n');
}

function columnIndex(reference: string | undefined): number {
  const letters = /^([A-Z]+)/.exec(reference ?? '')?.[1];
  if (!letters) return -1;
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function xlsxToText(sharedXml: string, sheetXml: string): string {
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((item) =>
    [...item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((text) => decodeXml(text[1]))
      .join(''),
  );

  const lines: string[] = [];
  for (const row of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const body = cell[2];
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';

      let value = '';
      if (type === 's') {
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '-1');
        value = shared[index] ?? '';
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map((text) => decodeXml(text[1]))
          .join('');
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }

      // 按单元格坐标补空位，避免表格串列。
      const column = columnIndex(/r="([^"]+)"/.exec(attrs)?.[1]);
      if (column >= 0) {
        while (cells.length < column) cells.push('');
      }
      cells.push(value.replace(/[\t\n]+/g, ' ').trim());
    }
    if (cells.some(Boolean)) lines.push(cells.join('\t').trimEnd());
  }

  return collapse(lines.join('\n'));
}

function pptxToText(slides: { index: number; xml: string }[]): string {
  return collapse(
    slides
      .map(
        (slide) =>
          `【第 ${slide.index} 页】\n${[
            ...slide.xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g),
          ]
            .map((text) => decodeXml(text[1]))
            .join('\n')}`,
      )
      .join('\n\n'),
  );
}

export type OfficeExtension = 'docx' | 'xlsx' | 'pptx';

export const OFFICE_EXTENSIONS: OfficeExtension[] = ['docx', 'xlsx', 'pptx'];

/** 提取 OOXML 文档正文；内容为空或格式异常时抛出，由调用方降级处理。 */
export async function extractOfficeText(
  buffer: ArrayBuffer,
  extension: OfficeExtension,
): Promise<string> {
  if (extension === 'docx') {
    const parts = await openParts(buffer, (name) => name === 'word/document.xml');
    const document = parts.get('word/document.xml');
    if (!document) throw new Error('文档缺少正文部件');
    return docxToText(document);
  }

  if (extension === 'pptx') {
    const parts = await openParts(
      buffer,
      (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name),
    );
    const slides = [...parts.entries()]
      .map(([name, xml]) => ({
        index: Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0),
        xml,
      }))
      .sort((a, b) => a.index - b.index);
    if (!slides.length) throw new Error('演示文稿没有可读页面');
    return pptxToText(slides);
  }

  const parts = await openParts(
    buffer,
    (name) => name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  );
  const shared = parts.get('xl/sharedStrings.xml') ?? '';
  const sheets = [...parts.entries()]
    .filter(([name]) => name.startsWith('xl/worksheets/'))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));

  if (!sheets.length) throw new Error('工作簿没有可读工作表');
  return sheets
    .map(([, xml]) => xlsxToText(shared, xml))
    .filter(Boolean)
    .join('\n\n');
}
