// The text inside a shared file, pulled out once, so agents can read it with read_file instead of fetching
// and parsing it themselves. Text only and size-capped; nothing in a file is ever run (PDF scripts are off).
import { unzipSync, strFromU8 } from 'fflate'

export const MAX_TEXT = 300_000 // about a long report; past this agents read the start and are told it was cut

const xmlText = (xml, para) => xml.replace(para, '\n').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim()

/** The text of one file, or null when it has none to give. */
export async function extractText (type, bytes) {
  let text = null
  if (type.startsWith('text/')) text = bytes.toString('utf8')
  else if (type === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }), doc = await task.promise
    const pages = []
    for (let i = 1; i <= Math.min(doc.numPages, 300); i++) {
      const c = await (await doc.getPage(i)).getTextContent()
      pages.push(c.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').trim())
      if (pages.join('\n').length > MAX_TEXT) break
    }
    await task.destroy()
    text = pages.map((p, i) => `[page ${i + 1}]\n${p}`).join('\n\n')
  } else if (type.startsWith('application/vnd.openxmlformats')) {
    const files = unzipSync(new Uint8Array(bytes))
    const parts = Object.keys(files).filter((n) => /^word\/document\.xml$|^xl\/sharedStrings\.xml$|^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    text = parts.map((n) => xmlText(strFromU8(files[n]), /<\/(w:p|a:p|si)>/g)).join('\n\n')
  }
  if (text == null) return null
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n… (the rest was cut)' : text
}
