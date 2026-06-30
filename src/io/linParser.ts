// Parser für AutoCAD .lin Linientyp-Definitionsdateien.
// Liefert benannte Strichmuster (dash patterns) zur späteren Übernahme in die LineStyle-Bibliothek.

export interface LinPattern {
  name: string;
  description: string;
  dash: number[] | null;
}

// Punkt (0) wird als sehr kurzer Strich dargestellt, da SVG dasharray keine echten Punkte kennt.
const DOT_LENGTH = 0.01;

// Zerlegt eine Musterzeile in Tokens und entfernt eingeklammerte Shape-/Text-Segmente.
function extractNumericSegments(patternLine: string): number[] {
  // Klammer-Segmente (z. B. ["TEXT",STYLE,...]) entfernen.
  const withoutBrackets = patternLine.replace(/\[[^\]]*\]/g, '');
  const tokens = withoutBrackets.split(',');
  const numbers: number[] = [];
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === '') continue;
    // Alignment-Token überspringen (üblicherweise 'A').
    if (/^[A-Za-z]/.test(token)) continue;
    const value = Number(token);
    if (Number.isFinite(value)) {
      numbers.push(value);
    }
    // Nicht-numerische Tokens werden ignoriert.
  }
  return numbers;
}

// Wandelt die Roh-Segmente in ein positives alternierendes dash/gap-Array um.
function toDashArray(segments: number[]): number[] | null {
  if (segments.length === 0) return null;
  const dash: number[] = [];
  for (const seg of segments) {
    if (seg === 0) {
      dash.push(DOT_LENGTH);
    } else {
      dash.push(Math.abs(seg));
    }
  }
  return dash.length > 0 ? dash : null;
}

export function parseLin(text: string): LinPattern[] {
  const result: LinPattern[] = [];
  // CRLF/CR vereinheitlichen.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (line.startsWith(';')) continue;
    if (!line.startsWith('*')) continue;

    // Definitionszeile: *NAME,Description
    const body = line.slice(1);
    const commaIndex = body.indexOf(',');
    const name = (commaIndex >= 0 ? body.slice(0, commaIndex) : body).trim();
    const description = commaIndex >= 0 ? body.slice(commaIndex + 1).trim() : '';
    if (name === '') continue;

    // Folgende Musterzeile suchen (Kommentare/Leerzeilen überspringen).
    let j = i + 1;
    while (j < lines.length) {
      const candidate = lines[j].trim();
      if (candidate === '' || candidate.startsWith(';')) {
        j++;
        continue;
      }
      break;
    }
    // Keine folgende Zeile oder direkt nächste Definition -> Eintrag überspringen.
    if (j >= lines.length || lines[j].trim().startsWith('*')) {
      continue;
    }

    const patternLine = lines[j].trim();
    const segments = extractNumericSegments(patternLine);
    const dash = toDashArray(segments);
    result.push({ name, description, dash });
    i = j;
  }

  return result;
}
