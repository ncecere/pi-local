import { createRequire } from "node:module";
import { strToU8, zipSync } from "fflate";

const require = createRequire(import.meta.url);

/** Small Office and PDF files built in code, for the document tests (no binary fixtures in the repository). */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export function docx(): Uint8Array {
	const body = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Summary</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Sales grew </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>12%</w:t></w:r><w:r><w:t xml:space="preserve"> &amp; costs fell.</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First point</w:t></w:r></w:p>
<w:p><w:r><w:delText>removed text</w:delText></w:r><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>North | East</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>40</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p/>
</w:body></w:document>`;
	return zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(body) });
}

export function xlsx(): Uint8Array {
	const workbook = `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
<sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>`;
	const rels = `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`;
	const strings = `<sst><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Rent</t></r><r><t xml:space="preserve"> (office)</t></r></si><si><t>Paid</t></si></sst>`;
	const sheet1 = `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200.5</v></c><c r="C2" t="b"><v>1</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Power</t></is></c><c r="C3" t="b"><v>0</v></c></row>
</sheetData></worksheet>`;
	const sheet2 = `<worksheet><sheetData/></worksheet>`;
	return zipSync({
		"xl/workbook.xml": strToU8(workbook),
		"xl/_rels/workbook.xml.rels": strToU8(rels),
		"xl/sharedStrings.xml": strToU8(strings),
		"xl/worksheets/sheet1.xml": strToU8(sheet1),
		"xl/worksheets/sheet2.xml": strToU8(sheet2),
	});
}

export function pptx(): Uint8Array {
	const presentation = `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`;
	const rels = `<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>`;
	const slide = (title: string, bullet: string) =>
		`<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p><a:p><a:r><a:t>${bullet}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
	const notes = `<p:notes><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Say hello first.</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
	return zipSync({
		"ppt/presentation.xml": strToU8(presentation),
		"ppt/_rels/presentation.xml.rels": strToU8(rels),
		"ppt/slides/slide1.xml": strToU8(slide("Later slide", "Second in order")),
		"ppt/slides/slide2.xml": strToU8(slide("Welcome", "Opening point")),
		"ppt/slides/_rels/slide2.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide1.xml"/></Relationships>`),
		"ppt/notesSlides/notesSlide1.xml": strToU8(notes),
	});
}

/** A PDF with one line of text on each page (Helvetica, no fonts embedded), offsets computed. */
export function pdf(pages: string[]): Uint8Array {
	const objects: string[] = [];
	const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
	objects.push("<< /Type /Catalog /Pages 2 0 R >>");
	objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	pages.forEach((text, i) => {
		const stream = text ? `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET` : "";
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
		objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	});
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

/** A solid-color PNG of the given size (RGB, no filtering), for image tests. */
export function png(width: number, height: number): Uint8Array {
	const { deflateSync, crc32 } = require("node:zlib") as typeof import("node:zlib");
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set([40, 120, 200], 1 + x * 3);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return new Uint8Array(
		Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]),
	);
}
